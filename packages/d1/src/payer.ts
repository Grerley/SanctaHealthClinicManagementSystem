/**
 * Third-party payer coverage, pre-authorisation & claims on D1 (BIL-011, §10.3;
 * optional). Eligibility is derived from active coverage as-of a date; a claim is
 * raised against an invoice for a covered patient; the payer's remittance is
 * recorded. A PAID claim settles through the normal payment path — a payer bank
 * payment allocated to the invoice — so the ledger and debtor balance stay correct
 * and a claim never creates a shadow balance. Ported from the Postgres edge
 * `payer.ts`.
 *
 * D1 translations: boolean active → INTEGER 0/1; interactive tx → the shared
 * billing helpers (each atomic via db.batch) plus a guarded status transition
 * (WHERE status='submitted') as the lock-free double-adjudication gate.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run } from './query.ts';
import { recordPayment, allocate, invoiceOutstanding } from './billing.ts';

export class PayerError extends Error {}

export async function registerPayer(db: D1Database, args: { code: string; name: string }): Promise<{ id: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new PayerError('payer code and name are required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO billing_payer (id, code, name) VALUES (?,?,?)`).bind(id, args.code, args.name).run();
  return { id };
}

export async function addCoverage(
  db: D1Database,
  args: { patientId: string; payerId: string; memberNumber: string; plan?: string; priority?: number; effectiveFrom: string; effectiveTo?: string },
): Promise<{ id: string }> {
  if (!args.memberNumber?.trim()) throw new PayerError('a member number is required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO billing_coverage (id, patient_id, payer_id, member_number, plan, priority, effective_from, effective_to) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, args.patientId, args.payerId, args.memberNumber, args.plan ?? null, args.priority ?? 1, args.effectiveFrom, args.effectiveTo ?? null).run();
  return { id };
}

export type Eligibility = { coverageId: string; payer: string; memberNumber: string; plan: string | null; priority: number };

/** Active coverage for a patient as-of a date, primary first (BIL-011). */
export async function checkEligibility(db: D1Database, args: { patientId: string; asOf: string }): Promise<{ eligible: boolean; coverages: Eligibility[] }> {
  const rows = await many<{ id: string; payer: string; member_number: string; plan: string | null; priority: number }>(
    db,
    `SELECT c.id, p.name AS payer, c.member_number, c.plan, c.priority
     FROM billing_coverage c JOIN billing_payer p ON p.id = c.payer_id
     WHERE c.patient_id=? AND c.active=1 AND p.active=1
       AND c.effective_from <= ? AND (c.effective_to IS NULL OR ? <= c.effective_to)
     ORDER BY c.priority`,
    [args.patientId, args.asOf, args.asOf],
  );
  const coverages = rows.map((x) => ({ coverageId: x.id, payer: x.payer, memberNumber: x.member_number, plan: x.plan, priority: Number(x.priority) }));
  return { eligible: coverages.length > 0, coverages };
}

/** Request a pre-authorisation for a service (BIL-011). */
export async function requestPreauth(db: D1Database, args: { reference: string; patientId: string; payerId: string; serviceCode: string; note?: string }): Promise<{ id: string }> {
  const id = uuidv7();
  await db.prepare(`INSERT INTO billing_preauth (id, reference, patient_id, payer_id, service_code, note) VALUES (?,?,?,?,?,?)`)
    .bind(id, args.reference, args.patientId, args.payerId, args.serviceCode, args.note ?? null).run();
  return { id };
}

/** Approve or decline a pre-authorisation (BIL-011). */
export async function decidePreauth(db: D1Database, args: { preauthId: string; approve: boolean; authorisation?: string }): Promise<{ status: 'approved' | 'declined' }> {
  const status = args.approve ? 'approved' : 'declined';
  const changed = await run(db, `UPDATE billing_preauth SET status=?, authorisation=?, decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='requested'`,
    [status, args.authorisation ?? null, args.preauthId]);
  if (changed === 0) throw new PayerError('pre-authorisation not found or already decided');
  return { status };
}

/** Submit a claim for a covered invoice (BIL-011). Claims the invoice's current outstanding by default. */
export async function submitClaim(db: D1Database, args: { claimNumber: string; invoiceId: string; coverageId: string; amountMinor?: number }): Promise<{ id: string; submittedMinor: number }> {
  const cov = await one<{ payer_id: string }>(db, `SELECT payer_id FROM billing_coverage WHERE id=? AND active=1`, [args.coverageId]);
  if (!cov) throw new PayerError('active coverage not found');
  const outstanding = await invoiceOutstanding(db, args.invoiceId);
  if (outstanding <= 0) throw new PayerError('invoice has nothing outstanding to claim');
  const submittedMinor = args.amountMinor ?? outstanding;
  if (submittedMinor <= 0 || submittedMinor > outstanding) throw new PayerError('claim amount must be within the outstanding balance');
  const id = uuidv7();
  await db.prepare(`INSERT INTO billing_claim (id, claim_number, invoice_id, coverage_id, payer_id, submitted_minor) VALUES (?,?,?,?,?,?)`)
    .bind(id, args.claimNumber, args.invoiceId, args.coverageId, cov.payer_id, submittedMinor).run();
  return { id, submittedMinor };
}

/**
 * Adjudicate a claim (BIL-011). On accept/pay, the paid portion is settled as a
 * payer bank payment allocated to the invoice (so the balance drops through the
 * ledger); the disallowed remainder is recorded as an adjustment. A rejected
 * claim records the reason and leaves the balance with the patient. A guarded
 * status transition (WHERE status='submitted') prevents double-adjudication.
 */
export async function adjudicateClaim(
  db: D1Database,
  args: { claimId: string; accept: boolean; paidMinor?: number; reason?: string; user?: string },
): Promise<{ status: 'paid' | 'accepted' | 'rejected'; paidMinor: number; adjustmentMinor: number }> {
  const claim = await one<{ invoice_id: string; submitted_minor: number; status: string }>(db, `SELECT invoice_id, submitted_minor, status FROM billing_claim WHERE id=?`, [args.claimId]);
  if (!claim) throw new PayerError('claim not found');
  const submitted = Number(claim.submitted_minor);
  const invoiceId = claim.invoice_id;

  // Atomically claim the transition; a concurrent adjudication loses the race here.
  const claimed = await run(db, `UPDATE billing_claim SET status='adjudicating' WHERE id=? AND status='submitted'`, [args.claimId]);
  if (claimed === 0) throw new PayerError(`claim already ${claim.status}`);

  if (!args.accept) {
    await run(db, `UPDATE billing_claim SET status='rejected', decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [args.claimId]);
    await db.prepare(`INSERT INTO billing_claim_remittance (id, claim_id, paid_minor, adjustment_minor, reason) VALUES (?,?,0,?,?)`)
      .bind(uuidv7(), args.claimId, submitted, args.reason ?? 'rejected').run();
    return { status: 'rejected', paidMinor: 0, adjustmentMinor: submitted };
  }

  const paidMinor = args.paidMinor ?? submitted;
  if (paidMinor < 0 || paidMinor > submitted) throw new PayerError('paid amount must be within the submitted amount');
  const adjustmentMinor = submitted - paidMinor;

  const inv = await one<{ patient_id: string }>(db, `SELECT patient_id FROM billing_invoice WHERE id=?`, [invoiceId]);
  if (!inv) throw new PayerError('invoice not found');

  let paymentId: string | null = null;
  if (paidMinor > 0) {
    const pay = await recordPayment(db, { patientId: inv.patient_id, method: 'bank', amountMinor: paidMinor, ...(args.user ? { user: args.user } : {}) });
    await allocate(db, { paymentId: pay.paymentId, allocations: [{ invoiceId, amountMinor: paidMinor }], ...(args.user ? { user: args.user } : {}) });
    paymentId = pay.paymentId;
  }
  const status = paidMinor > 0 ? 'paid' : 'accepted';
  await run(db, `UPDATE billing_claim SET status=?, decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [status, args.claimId]);
  await db.prepare(`INSERT INTO billing_claim_remittance (id, claim_id, paid_minor, adjustment_minor, payment_id, reason) VALUES (?,?,?,?,?,?)`)
    .bind(uuidv7(), args.claimId, paidMinor, adjustmentMinor, paymentId, args.reason ?? null).run();
  return { status, paidMinor, adjustmentMinor };
}
