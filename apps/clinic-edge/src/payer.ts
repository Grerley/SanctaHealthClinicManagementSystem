/**
 * Third-party payer coverage, pre-authorisation & claims (BIL-011, pack §10.3;
 * optional). Eligibility is derived from active coverage as-of a date; a claim is
 * raised against an invoice for a covered patient; the payer's remittance is
 * recorded. A PAID claim settles through the normal payment path — a payer bank
 * payment allocated to the invoice — so the ledger and debtor balance stay
 * correct and a claim never creates a shadow balance.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';
import { recordPayment, allocate, invoiceOutstanding } from './billing.ts';

export class PayerError extends Error {}

export async function registerPayer(pool: Pool, args: { code: string; name: string }): Promise<{ id: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new PayerError('payer code and name are required');
  const id = uuidv7();
  await pool.query(`INSERT INTO billing.payer (id, code, name) VALUES ($1,$2,$3)`, [id, args.code, args.name]);
  return { id };
}

export async function addCoverage(
  pool: Pool,
  args: { patientId: string; payerId: string; memberNumber: string; plan?: string; priority?: number; effectiveFrom: string; effectiveTo?: string },
): Promise<{ id: string }> {
  if (!args.memberNumber?.trim()) throw new PayerError('a member number is required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO billing.coverage (id, patient_id, payer_id, member_number, plan, priority, effective_from, effective_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, args.patientId, args.payerId, args.memberNumber, args.plan ?? null, args.priority ?? 1, args.effectiveFrom, args.effectiveTo ?? null],
  );
  return { id };
}

export type Eligibility = { coverageId: string; payer: string; memberNumber: string; plan: string | null; priority: number };

/** Active coverage for a patient as-of a date, primary first (BIL-011). */
export async function checkEligibility(pool: Pool, args: { patientId: string; asOf: string }): Promise<{ eligible: boolean; coverages: Eligibility[] }> {
  const r = await pool.query(
    `SELECT c.id, p.name AS payer, c.member_number, c.plan, c.priority
     FROM billing.coverage c JOIN billing.payer p ON p.id = c.payer_id
     WHERE c.patient_id=$1 AND c.active AND p.active
       AND c.effective_from <= $2 AND (c.effective_to IS NULL OR $2 <= c.effective_to)
     ORDER BY c.priority`,
    [args.patientId, args.asOf],
  );
  const coverages = r.rows.map((x) => ({ coverageId: x.id, payer: x.payer, memberNumber: x.member_number, plan: x.plan, priority: x.priority }));
  return { eligible: coverages.length > 0, coverages };
}

/** Request a pre-authorisation for a service (BIL-011). */
export async function requestPreauth(pool: Pool, args: { reference: string; patientId: string; payerId: string; serviceCode: string; note?: string }): Promise<{ id: string }> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO billing.preauth (id, reference, patient_id, payer_id, service_code, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.reference, args.patientId, args.payerId, args.serviceCode, args.note ?? null],
  );
  return { id };
}

/** Approve or decline a pre-authorisation (BIL-011). */
export async function decidePreauth(pool: Pool, args: { preauthId: string; approve: boolean; authorisation?: string }): Promise<{ status: 'approved' | 'declined' }> {
  const status = args.approve ? 'approved' : 'declined';
  const r = await pool.query(
    `UPDATE billing.preauth SET status=$2, authorisation=$3, decided_at=now() WHERE id=$1 AND status='requested'`,
    [args.preauthId, status, args.authorisation ?? null],
  );
  if (r.rowCount === 0) throw new PayerError('pre-authorisation not found or already decided');
  return { status };
}

/** Submit a claim for a covered invoice (BIL-011). Claims the invoice's current outstanding by default. */
export async function submitClaim(pool: Pool, args: { claimNumber: string; invoiceId: string; coverageId: string; amountMinor?: number }): Promise<{ id: string; submittedMinor: number }> {
  const cov = await pool.query(`SELECT payer_id FROM billing.coverage WHERE id=$1 AND active`, [args.coverageId]);
  if (cov.rows.length === 0) throw new PayerError('active coverage not found');
  const outstanding = await invoiceOutstanding(pool, args.invoiceId);
  if (outstanding <= 0) throw new PayerError('invoice has nothing outstanding to claim');
  const submittedMinor = args.amountMinor ?? outstanding;
  if (submittedMinor <= 0 || submittedMinor > outstanding) throw new PayerError('claim amount must be within the outstanding balance');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO billing.claim (id, claim_number, invoice_id, coverage_id, payer_id, submitted_minor) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.claimNumber, args.invoiceId, args.coverageId, cov.rows[0].payer_id, submittedMinor],
  );
  return { id, submittedMinor };
}

/**
 * Adjudicate a claim (BIL-011). On accept/pay, the paid portion is settled as a
 * payer bank payment allocated to the invoice (so the balance drops through the
 * ledger); the disallowed remainder is recorded as an adjustment. A rejected
 * claim records the reason and leaves the balance with the patient.
 */
export async function adjudicateClaim(
  pool: Pool,
  args: { claimId: string; accept: boolean; paidMinor?: number; reason?: string; user?: string },
): Promise<{ status: 'paid' | 'accepted' | 'rejected'; paidMinor: number; adjustmentMinor: number }> {
  const claim = await pool.query(`SELECT invoice_id, submitted_minor, status FROM billing.claim WHERE id=$1`, [args.claimId]);
  if (claim.rows.length === 0) throw new PayerError('claim not found');
  if (claim.rows[0].status !== 'submitted') throw new PayerError(`claim already ${claim.rows[0].status}`);
  const submitted = Number(claim.rows[0].submitted_minor);
  const invoiceId = claim.rows[0].invoice_id as string;

  if (!args.accept) {
    await pool.query(`UPDATE billing.claim SET status='rejected', decided_at=now() WHERE id=$1`, [args.claimId]);
    await pool.query(`INSERT INTO billing.claim_remittance (id, claim_id, paid_minor, adjustment_minor, reason) VALUES ($1,$2,0,$3,$4)`, [uuidv7(), args.claimId, submitted, args.reason ?? 'rejected']);
    return { status: 'rejected', paidMinor: 0, adjustmentMinor: submitted };
  }

  const paidMinor = args.paidMinor ?? submitted;
  if (paidMinor < 0 || paidMinor > submitted) throw new PayerError('paid amount must be within the submitted amount');
  const adjustmentMinor = submitted - paidMinor;

  // The patient — needed to raise the payer payment against their account.
  const inv = await pool.query(`SELECT patient_id FROM billing.invoice WHERE id=$1`, [invoiceId]);
  if (inv.rows.length === 0) throw new PayerError('invoice not found');

  let paymentId: string | null = null;
  if (paidMinor > 0) {
    const pay = await recordPayment(pool, { patientId: inv.rows[0].patient_id, method: 'bank', amountMinor: paidMinor, ...(args.user ? { user: args.user } : {}) });
    await allocate(pool, { paymentId: pay.paymentId, allocations: [{ invoiceId, amountMinor: paidMinor }], ...(args.user ? { user: args.user } : {}) });
    paymentId = pay.paymentId;
  }
  const status = paidMinor > 0 ? 'paid' : 'accepted';
  await pool.query(`UPDATE billing.claim SET status=$2, decided_at=now() WHERE id=$1`, [args.claimId, status]);
  await pool.query(
    `INSERT INTO billing.claim_remittance (id, claim_id, paid_minor, adjustment_minor, payment_id, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [uuidv7(), args.claimId, paidMinor, adjustmentMinor, paymentId, args.reason ?? null],
  );
  return { status, paidMinor, adjustmentMinor };
}
