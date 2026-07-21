/**
 * Front-desk operations (PAT-006, VIS-002, pack §4). The patient card carries a
 * PHI-free QR that resolves to the record on scan; the check-in view shows the
 * reception team only what they need — identity, outstanding tasks and account
 * balance — and deliberately NO clinical detail (diagnoses, results, notes).
 */
import type { Pool } from 'pg';
import { patientCardQr, resolvePatientCardQr } from '@sancta/domain';

export class FrontDeskError extends Error {}

export type PatientCard = { patientId: string; mrn: string | null; name: string; dateOfBirth: string | null; qr: string };

/** Printable patient card. The QR encodes only an opaque reference (PAT-006). */
export async function patientCard(pool: Pool, patientId: string): Promise<PatientCard> {
  const r = await pool.query(`SELECT id, mrn, given_name, family_name, to_char(date_of_birth,'YYYY-MM-DD') AS dob FROM identity.patient WHERE id=$1`, [patientId]);
  if (r.rows.length === 0) throw new FrontDeskError('patient not found');
  const x = r.rows[0];
  return { patientId: x.id, mrn: x.mrn, name: `${x.given_name ?? ''} ${x.family_name ?? ''}`.trim(), dateOfBirth: x.dob, qr: patientCardQr(x.id) };
}

/** Resolve a scanned card QR back to the patient (PAT-006). */
export async function resolveCard(pool: Pool, payload: string): Promise<{ patientId: string; mrn: string | null; name: string }> {
  const id = resolvePatientCardQr(payload);
  if (!id) throw new FrontDeskError('unrecognised patient card');
  const r = await pool.query(`SELECT id, mrn, given_name, family_name FROM identity.patient WHERE id=$1`, [id]);
  if (r.rows.length === 0) throw new FrontDeskError('patient not found');
  const x = r.rows[0];
  return { patientId: x.id, mrn: x.mrn, name: `${x.given_name ?? ''} ${x.family_name ?? ''}`.trim() };
}

async function patientBalanceMinor(pool: Pool, patientId: string): Promise<number> {
  const r = await pool.query(
    `SELECT coalesce(sum(
        ( (SELECT coalesce(sum(applied_minor+tax_minor),0) FROM billing.invoice_line l WHERE l.invoice_id=i.id)
        - (SELECT coalesce(sum(amount_minor),0) FROM billing.payment_allocation a WHERE a.invoice_id=i.id) )
      ),0)::bigint AS balance
     FROM billing.invoice i WHERE i.patient_id=$1 AND i.status IN ('finalised','part_paid','paid')`,
    [patientId],
  );
  return Number(r.rows[0].balance);
}

export type CheckInView = {
  visitId: string;
  patient: { patientId: string; mrn: string | null; name: string };
  accountBalanceMinor: number;
  tasks: string[];
  clinicalDetailIncluded: false; // explicit: this view never carries clinical data (VIS-002)
};

/**
 * The reception check-in view (VIS-002). Shows identity, outstanding tasks and
 * balance only — never clinical detail. Tasks here are logistical (settle
 * balance, confirm details), NOT the clinical task list used to gate completion.
 */
export async function checkInView(pool: Pool, visitId: string): Promise<CheckInView> {
  const v = await pool.query(
    `SELECT p.id, p.mrn, p.given_name, p.family_name FROM flow.visit vs JOIN identity.patient p ON p.id = vs.patient_id WHERE vs.id=$1`,
    [visitId],
  );
  if (v.rows.length === 0) throw new FrontDeskError('visit not found');
  const p = v.rows[0];
  const accountBalanceMinor = await patientBalanceMinor(pool, p.id);

  const tasks: string[] = ['Confirm patient identity and contact details'];
  if (accountBalanceMinor > 0) tasks.push('Outstanding balance to settle at cashier');

  return {
    visitId,
    patient: { patientId: p.id, mrn: p.mrn, name: `${p.given_name ?? ''} ${p.family_name ?? ''}`.trim() },
    accountBalanceMinor,
    tasks,
    clinicalDetailIncluded: false,
  };
}
