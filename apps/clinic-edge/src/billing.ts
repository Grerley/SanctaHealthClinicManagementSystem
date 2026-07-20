/**
 * Payment allocation & reallocation (BIL-006, BR-006, UAT-08). A payment is
 * separate from its allocation: recording a payment credits the AR control
 * account once; allocations decide which invoices it applies to. Reallocation is
 * append-only — a compensating negative entry plus a new positive entry — so the
 * full history is preserved and never edited (BR-006).
 */
import type { Pool } from 'pg';
import { uuidv7, money, postPaymentReceived, postRefund } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

export class BillingError extends Error {}

const POSTING_DATE = '2026-07-19';

/** Record a patient payment (unallocated) and post Dr cash / Cr AR once. */
export async function recordPayment(
  pool: Pool,
  args: { patientId: string; method: 'cash' | 'bank' | 'mobile'; amountMinor: number; user?: string },
): Promise<{ paymentId: string }> {
  if (args.amountMinor <= 0) throw new BillingError('payment amount must be positive');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const paymentId = uuidv7();
    await client.query(
      `INSERT INTO billing.payment (id, receipt_number, patient_id, method, amount_minor, currency, status)
       VALUES ($1,$2,$3,$4,$5,'USD','confirmed')`,
      [paymentId, 'RCT-' + paymentId.slice(-12), args.patientId, args.method, args.amountMinor],
    );
    const journal = postPaymentReceived({ batchId: uuidv7(), postingDate: POSTING_DATE }, paymentId, money(args.amountMinor), args.method);
    await insertJournalBatch(client, journal, POSTING_DATE.slice(0, 7));
    await client.query('COMMIT');
    return { paymentId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function allocatedTotal(pool: Pool, paymentId: string): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM billing.payment_allocation WHERE payment_id=$1`, [paymentId]);
  return Number(r.rows[0].n);
}

async function paymentAmount(pool: Pool, paymentId: string): Promise<number> {
  const r = await pool.query(`SELECT amount_minor FROM billing.payment WHERE id=$1`, [paymentId]);
  if (r.rows.length === 0) throw new BillingError('payment not found');
  return Number(r.rows[0].amount_minor);
}

/** Allocate part of a payment to invoices. Total allocated cannot exceed the payment. */
export async function allocate(pool: Pool, args: { paymentId: string; allocations: Array<{ invoiceId: string; amountMinor: number }>; user?: string }): Promise<void> {
  const amount = await paymentAmount(pool, args.paymentId);
  const already = await allocatedTotal(pool, args.paymentId);
  const adding = args.allocations.reduce((s, a) => s + a.amountMinor, 0);
  if (already + adding > amount) throw new BillingError(`allocation ${already + adding} exceeds payment ${amount}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of args.allocations) {
      await client.query(`INSERT INTO billing.payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES ($1,$2,$3,$4)`, [
        uuidv7(),
        args.paymentId,
        a.invoiceId,
        a.amountMinor,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Move an allocated amount from one invoice to another WITHOUT editing history:
 * append a negative entry on `from` and a positive entry on `to` (BR-006).
 */
export async function reallocate(pool: Pool, args: { paymentId: string; fromInvoiceId: string; toInvoiceId: string; amountMinor: number; user?: string }): Promise<void> {
  if (args.amountMinor <= 0) throw new BillingError('reallocation amount must be positive');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Net currently on the source invoice for this payment.
    const net = await client.query(
      `SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM billing.payment_allocation WHERE payment_id=$1 AND invoice_id=$2`,
      [args.paymentId, args.fromInvoiceId],
    );
    if (Number(net.rows[0].n) < args.amountMinor) {
      await client.query('ROLLBACK');
      throw new BillingError('cannot reallocate more than is allocated to the source invoice');
    }
    await client.query(`INSERT INTO billing.payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES ($1,$2,$3,$4)`, [
      uuidv7(),
      args.paymentId,
      args.fromInvoiceId,
      -args.amountMinor,
    ]);
    await client.query(`INSERT INTO billing.payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES ($1,$2,$3,$4)`, [
      uuidv7(),
      args.paymentId,
      args.toInvoiceId,
      args.amountMinor,
    ]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','payment_allocation',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.user ?? null, args.paymentId, `reallocate ${args.amountMinor} ${args.fromInvoiceId}->${args.toInvoiceId}`, 'realloc:' + uuidv7()],
    );
    await client.query('COMMIT');
  } catch (e) {
    if (e instanceof BillingError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Refund a payment through a linked compensating transaction (BIL-010). The
 * original payment/receipt is never edited: a refund row is created (with an
 * approver) and a reversing journal is posted. Refunds require authorisation and
 * cannot exceed the un-refunded amount of the payment.
 */
export async function refundPayment(
  pool: Pool,
  args: { paymentId: string; amountMinor: number; method: 'cash' | 'bank' | 'mobile'; reason: string; approver?: string },
): Promise<{ refundId: string }> {
  if (!args.approver) throw new BillingError('a refund requires an authorised approver');
  if (args.amountMinor <= 0) throw new BillingError('refund amount must be positive');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pay = await client.query(`SELECT amount_minor FROM billing.payment WHERE id=$1 FOR UPDATE`, [args.paymentId]);
    if (pay.rows.length === 0) throw new BillingError('payment not found');
    const already = await client.query(`SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM billing.refund WHERE payment_id=$1`, [args.paymentId]);
    const refundable = Number(pay.rows[0].amount_minor) - Number(already.rows[0].n);
    if (args.amountMinor > refundable) {
      await client.query('ROLLBACK');
      throw new BillingError(`refund ${args.amountMinor} exceeds refundable ${refundable}`);
    }
    const refundId = uuidv7();
    await client.query(
      `INSERT INTO billing.refund (id, payment_id, amount_minor, method, reason, approved_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [refundId, args.paymentId, args.amountMinor, args.method, args.reason, args.approver],
    );
    const journal = postRefund({ batchId: uuidv7(), postingDate: POSTING_DATE }, refundId, money(args.amountMinor), args.method);
    await insertJournalBatch(client, journal, POSTING_DATE.slice(0, 7));
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','refund',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.approver, refundId, args.reason, 'refund:' + refundId],
    );
    await client.query('COMMIT');
    return { refundId };
  } catch (e) {
    if (e instanceof BillingError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function invoiceOutstanding(pool: Pool, invoiceId: string): Promise<number> {
  const r = await pool.query(
    `SELECT ( (SELECT coalesce(sum(applied_minor+tax_minor),0) FROM billing.invoice_line WHERE invoice_id=$1)
            - (SELECT coalesce(sum(amount_minor),0) FROM billing.payment_allocation WHERE invoice_id=$1) )::bigint AS n`,
    [invoiceId],
  );
  return Number(r.rows[0].n);
}
