/**
 * Formulary search, dispensing worklist & printed prescriptions
 * (MED-001/005/006, pack §7.8). The formulary is searched locally (offline) with
 * live stock availability from the derived balance view; the dispensing worklist
 * shows only signed, undispensed medication requests; and a legally compliant
 * prescription is generated from the signed requests with prescriber details.
 */
import type { Pool } from 'pg';
import { prescriptionDoc, type ClinicalDocument, type PatientRef } from '@sancta/domain';

export class MedicationError extends Error {}

export type FormularyItem = { sku: string; name: string; category: string | null; controlled: boolean; onHand: number };

/**
 * Offline formulary search with stock availability (MED-001). Matches by SKU or
 * name; on-hand is summed from AVAILABLE lots only via the sanctioned balance view.
 * An optional location scopes availability.
 */
export async function searchFormulary(pool: Pool, q: string, location?: string): Promise<FormularyItem[]> {
  const term = `%${q.trim()}%`;
  const r = await pool.query(
    `SELECT p.sku, p.name, p.category, p.controlled,
            coalesce(sum(CASE WHEN l.status='available' THEN b.on_hand ELSE 0 END),0)::bigint AS on_hand
     FROM inventory.product p
     LEFT JOIN inventory.lot l ON l.sku = p.sku
     LEFT JOIN inventory.stock_balance b ON b.lot_id = l.id AND ($2::text IS NULL OR b.location = $2)
     WHERE p.sku ILIKE $1 OR p.name ILIKE $1
     GROUP BY p.sku, p.name, p.category, p.controlled
     ORDER BY p.name`,
    [term, location ?? null],
  );
  return r.rows.map((x) => ({ sku: x.sku, name: x.name, category: x.category, controlled: x.controlled, onHand: Number(x.on_hand) }));
}

export type WorklistItem = { requestId: string; patientId: string; medicineCode: string; dose: string | null; quantity: number | null; prescribedBy: string | null };

/** Dispensing worklist: signed, active, undispensed medication requests (MED-006). */
export async function dispensingWorklist(pool: Pool): Promise<WorklistItem[]> {
  const r = await pool.query(
    `SELECT id, patient_id, medicine_code, dose, quantity, prescribed_by
     FROM clinical.medication_request
     WHERE status='active' AND prescribed_by IS NOT NULL AND dispensed_at IS NULL
     ORDER BY created_at`,
  );
  return r.rows.map((x) => ({ requestId: x.id, patientId: x.patient_id, medicineCode: x.medicine_code, dose: x.dose, quantity: x.quantity, prescribedBy: x.prescribed_by }));
}

/** Mark a medication request dispensed so it leaves the worklist (MED-006). */
export async function markDispensed(pool: Pool, args: { requestId: string; dispensedBy?: string }): Promise<{ requestId: string }> {
  const r = await pool.query(
    `UPDATE clinical.medication_request SET status='dispensed', dispensed_at=now(), dispensed_by=$2
     WHERE id=$1 AND status='active' RETURNING id`,
    [args.requestId, args.dispensedBy ?? null],
  );
  if (r.rowCount === 0) throw new MedicationError('medication request not found or already dispensed');
  return { requestId: args.requestId };
}

/**
 * Generate a legally compliant printed prescription from a patient's signed,
 * active requests (MED-005). Includes the prescriber's name + registration number
 * and per-item patient instructions.
 */
export async function generatePrescription(pool: Pool, args: { patientId: string; prescriberId: string; date?: string }): Promise<ClinicalDocument> {
  const pr = await pool.query(`SELECT id, mrn, given_name, family_name FROM identity.patient WHERE id=$1`, [args.patientId]);
  if (pr.rowCount === 0) throw new MedicationError('patient not found');
  const p = pr.rows[0];
  const patient: PatientRef = { id: p.id, mrn: p.mrn, name: `${p.family_name ?? ''}, ${p.given_name ?? ''}`.trim() };

  const reqs = await pool.query(
    `SELECT mr.medicine_code, coalesce(prod.name, mr.medicine_code) AS name, mr.dose, mr.route, mr.frequency, mr.duration_days, mr.instructions
     FROM clinical.medication_request mr LEFT JOIN inventory.product prod ON prod.sku = mr.medicine_code
     WHERE mr.patient_id=$1 AND mr.status='active' AND mr.prescribed_by=$2 ORDER BY mr.created_at`,
    [args.patientId, args.prescriberId],
  );
  if (reqs.rowCount === 0) throw new MedicationError('no signed medication requests to print for this prescriber');

  const staff = await pool.query(`SELECT full_name, registration_no FROM organisation.staff WHERE id=$1`, [args.prescriberId]);
  const prescriber = staff.rowCount ? `${staff.rows[0].full_name}${staff.rows[0].registration_no ? ` (Reg. ${staff.rows[0].registration_no})` : ''}` : args.prescriberId;

  const items = reqs.rows.map((x) => ({
    drug: x.name + (x.route ? ` (${x.route})` : ''),
    dose: x.dose ?? '—',
    frequency: x.frequency ?? '—',
    duration: x.duration_days ? `${x.duration_days} days` : 'as directed',
  }));
  const doc = prescriptionDoc({ patient, date: args.date ?? new Date().toISOString().slice(0, 10), prescriber, items });
  // Append patient instructions where present (legal patient-facing directions).
  const instructions = reqs.rows.filter((x) => x.instructions).map((x) => `${x.name}: ${x.instructions}`);
  if (instructions.length) doc.sections.push({ heading: 'Patient instructions', lines: instructions });
  return doc;
}
