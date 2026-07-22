/**
 * Formulary search, dispensing worklist & printed prescriptions on D1
 * (MED-001/005/006). The formulary is searched with live stock from available
 * lots; the worklist shows signed, undispensed medication requests; a legally
 * compliant prescription is generated from the signed requests with prescriber
 * details. Ported from the Postgres edge `medication.ts`; the document builder is
 * the shared domain function.
 */
import { prescriptionDoc, type ClinicalDocument, type PatientRef } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run } from './query.ts';

export class MedicationError extends Error {}

export type FormularyItem = { sku: string; name: string; category: string | null; controlled: boolean; onHand: number };

/** Offline formulary search with stock availability (MED-001). Matches SKU/name;
 * on-hand summed from AVAILABLE lots only. Optional location scopes availability. */
export async function searchFormulary(db: D1Database, q: string, location?: string): Promise<FormularyItem[]> {
  const term = `%${q.trim()}%`;
  const rows = await many<{ sku: string; name: string; category: string | null; controlled: number; on_hand: number }>(
    db,
    `SELECT p.sku, p.name, p.category, p.controlled,
            COALESCE(SUM(CASE WHEN l.status='available' THEN b.on_hand ELSE 0 END),0) AS on_hand
     FROM inventory_product p
     LEFT JOIN inventory_lot l ON l.sku = p.sku
     LEFT JOIN inventory_stock_balance b ON b.lot_id = l.id AND (? IS NULL OR b.location = ?)
     WHERE p.sku LIKE ? OR p.name LIKE ?
     GROUP BY p.sku, p.name, p.category, p.controlled
     ORDER BY p.name`,
    [location ?? null, location ?? null, term, term],
  );
  return rows.map((x) => ({ sku: x.sku, name: x.name, category: x.category, controlled: !!x.controlled, onHand: Number(x.on_hand) }));
}

export type WorklistItem = { requestId: string; patientId: string; medicineCode: string; dose: string | null; quantity: number | null; prescribedBy: string | null };

/** Dispensing worklist: signed, active, undispensed medication requests (MED-006). */
export async function dispensingWorklist(db: D1Database): Promise<WorklistItem[]> {
  const rows = await many<{ id: string; patient_id: string; medicine_code: string; dose: string | null; quantity: number | null; prescribed_by: string | null }>(
    db, `SELECT id, patient_id, medicine_code, dose, quantity, prescribed_by FROM clinical_medication_request
         WHERE status='active' AND prescribed_by IS NOT NULL AND dispensed_at IS NULL ORDER BY created_at`);
  return rows.map((x) => ({ requestId: x.id, patientId: x.patient_id, medicineCode: x.medicine_code, dose: x.dose, quantity: x.quantity, prescribedBy: x.prescribed_by }));
}

/** Mark a medication request dispensed so it leaves the worklist (MED-006). */
export async function markDispensed(db: D1Database, args: { requestId: string; dispensedBy?: string }): Promise<{ requestId: string }> {
  const changed = await run(db, `UPDATE clinical_medication_request SET status='dispensed', dispensed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), dispensed_by=? WHERE id=? AND status='active'`,
    [args.dispensedBy ?? null, args.requestId]);
  if (changed === 0) throw new MedicationError('medication request not found or already dispensed');
  return { requestId: args.requestId };
}

/** Generate a legally compliant printed prescription from a patient's signed,
 * active requests (MED-005). Includes prescriber details + patient instructions. */
export async function generatePrescription(db: D1Database, args: { patientId: string; prescriberId: string; date?: string }): Promise<ClinicalDocument> {
  const p = await one<{ id: string; mrn: string; given_name: string | null; family_name: string | null }>(db, `SELECT id, mrn, given_name, family_name FROM identity_patient WHERE id=?`, [args.patientId]);
  if (!p) throw new MedicationError('patient not found');
  const patient: PatientRef = { id: p.id, mrn: p.mrn, name: `${p.family_name ?? ''}, ${p.given_name ?? ''}`.trim() };

  const reqs = await many<{ medicine_code: string; name: string; dose: string | null; route: string | null; frequency: string | null; duration_days: number | null; instructions: string | null }>(
    db, `SELECT mr.medicine_code, COALESCE(prod.name, mr.medicine_code) AS name, mr.dose, mr.route, mr.frequency, mr.duration_days, mr.instructions
         FROM clinical_medication_request mr LEFT JOIN inventory_product prod ON prod.sku = mr.medicine_code
         WHERE mr.patient_id=? AND mr.status='active' AND mr.prescribed_by=? ORDER BY mr.created_at`, [args.patientId, args.prescriberId]);
  if (reqs.length === 0) throw new MedicationError('no signed medication requests to print for this prescriber');

  const staff = await one<{ full_name: string; registration_no: string | null }>(db, `SELECT full_name, registration_no FROM organisation_staff WHERE id=?`, [args.prescriberId]);
  const prescriber = staff ? `${staff.full_name}${staff.registration_no ? ` (Reg. ${staff.registration_no})` : ''}` : args.prescriberId;

  const items = reqs.map((x) => ({
    drug: x.name + (x.route ? ` (${x.route})` : ''),
    dose: x.dose ?? '—',
    frequency: x.frequency ?? '—',
    duration: x.duration_days ? `${x.duration_days} days` : 'as directed',
  }));
  const doc = prescriptionDoc({ patient, date: args.date ?? new Date().toISOString().slice(0, 10), prescriber, items });
  const instructions = reqs.filter((x) => x.instructions).map((x) => `${x.name}: ${x.instructions}`);
  if (instructions.length) doc.sections.push({ heading: 'Patient instructions', lines: instructions });
  return doc;
}
