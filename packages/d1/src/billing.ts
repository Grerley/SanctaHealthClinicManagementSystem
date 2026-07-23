/**
 * Payment allocation, reallocation & refunds on D1 (BIL-006/010, BR-006, UAT-08).
 * A payment is separate from its allocation: recording a payment credits AR once
 * (via a balanced journal); allocations decide which invoices it applies to.
 * Reallocation and refunds are append-only — a compensating negative entry plus a
 * new positive entry, and a linked refund row + reversing journal — so history is
 * preserved, never edited (BR-006). Ported from the Postgres edge `billing.ts`.
 *
 * D1 translations: interactive tx + FOR UPDATE → db.batch() with the caps checked
 * by prior reads (recording a payment credits AR once; allocation/refund totals
 * are validated before the write).
 */
import { uuidv7, money, postPaymentReceived, postRefund } from '@sancta/domain';
import type { D1Database, D1PreparedStatement } from './d1.ts';
import { one, many, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';
import { assertPeriodOpen } from './finance.ts';

export class BillingError extends Error {}

function today(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Record a patient payment (unallocated) and post Dr cash / Cr AR once. Idempotent
 * (safety scenario #8): when an `idempotencyKey` is supplied, a replay of the same
 * key returns the ORIGINAL payment instead of creating a second one — a queue
 * replay or a double-click never double-posts money (§8). The partial UNIQUE index
 * on idempotency_key is the lock-free gate.
 */
export async function recordPayment(
  db: D1Database,
  args: { patientId: string; method: 'cash' | 'bank' | 'mobile'; amountMinor: number; postingDate?: string; user?: string; idempotencyKey?: string },
): Promise<{ paymentId: string; duplicate?: boolean }> {
  if (args.amountMinor <= 0) throw new BillingError('payment amount must be positive');
  if (args.idempotencyKey) {
    const existing = await one<{ id: string }>(db, `SELECT id FROM billing_payment WHERE idempotency_key=?`, [args.idempotencyKey]);
    if (existing) return { paymentId: existing.id, duplicate: true };
  }
  const postingDate = args.postingDate ?? today();
  const periodId = postingDate.slice(0, 7);
  await ensurePeriod(db, periodId);
  await assertPeriodOpen(db, periodId);
  const paymentId = uuidv7();
  const journal = postPaymentReceived({ batchId: uuidv7(), postingDate }, paymentId, money(args.amountMinor), args.method);
  try {
    await db.batch([
      stmt(db, `INSERT INTO billing_payment (id, receipt_number, patient_id, method, amount_minor, currency, status, idempotency_key) VALUES (?,?,?,?,?, 'USD','confirmed', ?)`,
        [paymentId, 'RCT-' + paymentId.slice(-12), args.patientId, args.method, args.amountMinor, args.idempotencyKey ?? null]),
      ...journalStatements(db, journal, periodId),
    ]);
  } catch (e) {
    // Lost a race on the idempotency key — the winning payment stands.
    if (args.idempotencyKey && /UNIQUE/i.test(String((e as Error).message))) {
      const existing = await one<{ id: string }>(db, `SELECT id FROM billing_payment WHERE idempotency_key=?`, [args.idempotencyKey]);
      if (existing) return { paymentId: existing.id, duplicate: true };
    }
    throw e;
  }
  return { paymentId };
}

async function allocatedTotal(db: D1Database, paymentId: string): Promise<number> {
  const r = await one<{ n: number }>(db, `SELECT COALESCE(SUM(amount_minor),0) AS n FROM billing_payment_allocation WHERE payment_id=?`, [paymentId]);
  return Number(r?.n ?? 0);
}

async function paymentAmount(db: D1Database, paymentId: string): Promise<number> {
  const r = await one<{ amount_minor: number }>(db, `SELECT amount_minor FROM billing_payment WHERE id=?`, [paymentId]);
  if (!r) throw new BillingError('payment not found');
  return Number(r.amount_minor);
}

/** Allocate part of a payment to invoices. Total allocated cannot exceed the payment. */
export async function allocate(db: D1Database, args: { paymentId: string; allocations: Array<{ invoiceId: string; amountMinor: number }>; user?: string }): Promise<void> {
  const amount = await paymentAmount(db, args.paymentId);
  const already = await allocatedTotal(db, args.paymentId);
  const adding = args.allocations.reduce((s, a) => s + a.amountMinor, 0);
  if (already + adding > amount) throw new BillingError(`allocation ${already + adding} exceeds payment ${amount}`);
  await db.batch(args.allocations.map((a) =>
    stmt(db, `INSERT INTO billing_payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES (?,?,?,?)`, [uuidv7(), args.paymentId, a.invoiceId, a.amountMinor])));
}

/** Move an allocated amount between invoices WITHOUT editing history: append a
 * negative entry on `from` and a positive entry on `to` (BR-006). */
export async function reallocate(db: D1Database, args: { paymentId: string; fromInvoiceId: string; toInvoiceId: string; amountMinor: number; user?: string }): Promise<void> {
  if (args.amountMinor <= 0) throw new BillingError('reallocation amount must be positive');
  const net = await one<{ n: number }>(db, `SELECT COALESCE(SUM(amount_minor),0) AS n FROM billing_payment_allocation WHERE payment_id=? AND invoice_id=?`, [args.paymentId, args.fromInvoiceId]);
  if (Number(net?.n ?? 0) < args.amountMinor) throw new BillingError('cannot reallocate more than is allocated to the source invoice');
  await db.batch([
    stmt(db, `INSERT INTO billing_payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES (?,?,?,?)`, [uuidv7(), args.paymentId, args.fromInvoiceId, -args.amountMinor]),
    stmt(db, `INSERT INTO billing_payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES (?,?,?,?)`, [uuidv7(), args.paymentId, args.toInvoiceId, args.amountMinor]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','payment_allocation',?,'success',?,?)`,
      [uuidv7(), args.user ?? null, args.paymentId, `reallocate ${args.amountMinor} ${args.fromInvoiceId}->${args.toInvoiceId}`, 'realloc:' + uuidv7()]),
  ]);
}

/** Refund a payment via a linked, authorised compensating transaction (BIL-010).
 * The original is never edited; cannot exceed the un-refunded amount. */
export async function refundPayment(
  db: D1Database,
  args: { paymentId: string; amountMinor: number; method: 'cash' | 'bank' | 'mobile'; reason: string; approver?: string; postingDate?: string },
): Promise<{ refundId: string }> {
  if (!args.approver) throw new BillingError('a refund requires an authorised approver');
  if (args.amountMinor <= 0) throw new BillingError('refund amount must be positive');
  const pay = await one<{ amount_minor: number }>(db, `SELECT amount_minor FROM billing_payment WHERE id=?`, [args.paymentId]);
  if (!pay) throw new BillingError('payment not found');
  const already = await one<{ n: number }>(db, `SELECT COALESCE(SUM(amount_minor),0) AS n FROM billing_refund WHERE payment_id=?`, [args.paymentId]);
  const refundable = Number(pay.amount_minor) - Number(already?.n ?? 0);
  if (args.amountMinor > refundable) throw new BillingError(`refund ${args.amountMinor} exceeds refundable ${refundable}`);
  const postingDate = args.postingDate ?? today();
  const periodId = postingDate.slice(0, 7);
  await ensurePeriod(db, periodId);
  await assertPeriodOpen(db, periodId);
  const refundId = uuidv7();
  const journal = postRefund({ batchId: uuidv7(), postingDate }, refundId, money(args.amountMinor), args.method);
  const batch: D1PreparedStatement[] = [
    stmt(db, `INSERT INTO billing_refund (id, payment_id, amount_minor, method, reason, approved_by) VALUES (?,?,?,?,?,?)`,
      [refundId, args.paymentId, args.amountMinor, args.method, args.reason, args.approver]),
    ...journalStatements(db, journal, periodId),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','refund',?,'success',?,?)`,
      [uuidv7(), args.approver, refundId, args.reason, 'refund:' + refundId]),
  ];
  await db.batch(batch);
  return { refundId };
}

/** Outstanding on an invoice = Σ(line applied+tax) − Σ(allocations). */
export async function invoiceOutstanding(db: D1Database, invoiceId: string): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT ( (SELECT COALESCE(SUM(applied_minor+tax_minor),0) FROM billing_invoice_line WHERE invoice_id=?)
            - (SELECT COALESCE(SUM(amount_minor),0) FROM billing_payment_allocation WHERE invoice_id=?) ) AS n`,
    [invoiceId, invoiceId],
  );
  return Number(r?.n ?? 0);
}
