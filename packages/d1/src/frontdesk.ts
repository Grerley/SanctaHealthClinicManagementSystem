/**
 * Front-desk operations on D1 (PAT-006, VIS-002, §4). The patient card carries a
 * PHI-free QR that resolves to the record on scan; the check-in view shows the
 * reception team only what they need — identity, outstanding tasks and account
 * balance — and deliberately NO clinical detail (diagnoses, results, notes).
 * Ported from the Postgres edge `frontdesk.ts`. No new tables.
 */
import { patientCardQr, resolvePatientCardQr } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one } from './query.ts';

export class FrontDeskError extends Error {}

export type PatientCard = { patientId: string; mrn: string | null; name: string; dateOfBirth: string | null; qr: string };

/** Printable patient card. The QR encodes only an opaque reference (PAT-006). */
export async function patientCard(db: D1Database, patientId: string): Promise<PatientCard> {
  const x = await one<{ id: string; mrn: string | null; given_name: string | null; family_name: string | null; dob: string | null }>(db,
    `SELECT id, mrn, given_name, family_name, date_of_birth AS dob FROM identity_patient WHERE id=?`, [patientId]);
  if (!x) throw new FrontDeskError('patient not found');
  return { patientId: x.id, mrn: x.mrn, name: `${x.given_name ?? ''} ${x.family_name ?? ''}`.trim(), dateOfBirth: x.dob, qr: patientCardQr(x.id) };
}

/** Resolve a scanned card QR back to the patient (PAT-006). */
export async function resolveCard(db: D1Database, payload: string): Promise<{ patientId: string; mrn: string | null; name: string }> {
  const id = resolvePatientCardQr(payload);
  if (!id) throw new FrontDeskError('unrecognised patient card');
  const x = await one<{ id: string; mrn: string | null; given_name: string | null; family_name: string | null }>(db,
    `SELECT id, mrn, given_name, family_name FROM identity_patient WHERE id=?`, [id]);
  if (!x) throw new FrontDeskError('patient not found');
  return { patientId: x.id, mrn: x.mrn, name: `${x.given_name ?? ''} ${x.family_name ?? ''}`.trim() };
}

/** Outstanding patient account balance (derived, never stored). */
export async function patientBalanceMinor(db: D1Database, patientId: string): Promise<number> {
  const r = await one<{ balance: number }>(db,
    `SELECT COALESCE(SUM(
        ( (SELECT COALESCE(SUM(applied_minor+tax_minor),0) FROM billing_invoice_line l WHERE l.invoice_id=i.id)
        - (SELECT COALESCE(SUM(amount_minor),0) FROM billing_payment_allocation a WHERE a.invoice_id=i.id) )
      ),0) AS balance
     FROM billing_invoice i WHERE i.patient_id=? AND i.status IN ('finalised','part_paid','paid')`, [patientId]);
  return Number(r?.balance ?? 0);
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
export async function checkInView(db: D1Database, visitId: string): Promise<CheckInView> {
  const p = await one<{ id: string; mrn: string | null; given_name: string | null; family_name: string | null }>(db,
    `SELECT p.id, p.mrn, p.given_name, p.family_name FROM flow_visit vs JOIN identity_patient p ON p.id = vs.patient_id WHERE vs.id=?`, [visitId]);
  if (!p) throw new FrontDeskError('visit not found');
  const accountBalanceMinor = await patientBalanceMinor(db, p.id);
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
