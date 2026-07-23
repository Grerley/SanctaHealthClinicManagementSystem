/**
 * Prescribing with allergy checking and controlled override (MED-002/003/004/009,
 * UAT-05). A medication request is checked against the patient's active allergies
 * by substance code; a match blocks the prescription unless an authorised
 * prescriber supplies an override reason (recorded + audited). Templates propose
 * lines only — they never bypass the per-patient allergy check. Administrations
 * are append-only. Ported from the Postgres edge `prescribing.ts`.
 *
 * D1 translations: interactive tx → db.batch(); the not-given administration rule
 * is a table CHECK, as in Postgres.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class PrescribingError extends Error {}

export async function recordAllergy(db: D1Database, args: { patientId: string; substanceCode: string; severity?: 'low' | 'high' | 'critical' }): Promise<{ allergyId: string }> {
  const allergyId = uuidv7();
  await db.prepare(`INSERT INTO clinical_allergy (id, patient_id, substance_code, severity) VALUES (?,?,?,?)`)
    .bind(allergyId, args.patientId, args.substanceCode, args.severity ?? 'high').run();
  return { allergyId };
}

export type AllergyAlert = { substanceCode: string; severity: string };
export type PrescribeBody = {
  patientId: string; encounterId?: string; medicineCode: string; substanceCode: string;
  dose?: string; route?: string; frequency?: string; durationDays?: number; quantity?: number;
  instructions?: string; prescribedBy: string; override?: boolean; overrideReason?: string;
};
export type PrescribeResult = { ok: true; requestId: string; overridden: boolean } | { ok: false; alerts: AllergyAlert[] };

/** Create a medication request. A substance-matched active allergy blocks unless
 * overridden with a reason (MED-003). Override is recorded + audited. */
export async function prescribe(db: D1Database, body: PrescribeBody): Promise<PrescribeResult> {
  const allergies = await many<{ substance_code: string; severity: string }>(
    db, `SELECT substance_code, severity FROM clinical_allergy WHERE patient_id=? AND substance_code=?`, [body.patientId, body.substanceCode]);
  const alerts: AllergyAlert[] = allergies.map((r) => ({ substanceCode: r.substance_code, severity: r.severity }));

  if (alerts.length > 0 && !body.override) return { ok: false, alerts };
  if (alerts.length > 0 && body.override && !body.overrideReason) throw new PrescribingError('overriding an allergy alert requires a reason');

  const requestId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_medication_request (id, patient_id, encounter_id, medicine_code, substance_code, dose, route, frequency, duration_days, quantity, instructions, status, prescribed_by, override_reason, override_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
      [requestId, body.patientId, body.encounterId ?? null, body.medicineCode, body.substanceCode, body.dose ?? null, body.route ?? null, body.frequency ?? null,
       body.durationDays ?? null, body.quantity ?? null, body.instructions ?? null, body.prescribedBy,
       alerts.length > 0 ? body.overrideReason ?? null : null, alerts.length > 0 ? body.prescribedBy : null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'create','medication_request',?,?,'success',?,?)`,
      [uuidv7(), body.prescribedBy, requestId, body.patientId, alerts.length > 0 ? 'allergy override: ' + body.overrideReason : 'prescribed', 'rx:' + requestId]),
  ]);
  return { ok: true, requestId, overridden: alerts.length > 0 };
}

// --- Protocol templates / favourites (MED-004) ------------------------------

export type RxTemplateItem = { medicineCode: string; substanceCode: string; dose?: string; route?: string; frequency?: string; durationDays?: number; quantity?: number; instructions?: string };

export async function defineRxTemplate(db: D1Database, args: { code: string; name: string; items: RxTemplateItem[] }): Promise<{ code: string; itemCount: number }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new PrescribingError('template code and name are required');
  if (!args.items?.length) throw new PrescribingError('a protocol template needs at least one item');
  await db.batch([
    stmt(db, `INSERT INTO clinical_rx_template (code, name) VALUES (?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, active=1`, [args.code, args.name]),
    stmt(db, `DELETE FROM clinical_rx_template_item WHERE template_code=?`, [args.code]),
    ...args.items.map((it) => stmt(db,
      `INSERT INTO clinical_rx_template_item (id, template_code, medicine_code, substance_code, dose, route, frequency, duration_days, quantity, instructions)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv7(), args.code, it.medicineCode, it.substanceCode, it.dose ?? null, it.route ?? null, it.frequency ?? null, it.durationDays ?? null, it.quantity ?? null, it.instructions ?? null])),
  ]);
  return { code: args.code, itemCount: args.items.length };
}

export type RxProposal = RxTemplateItem & { requiresConfirmation: true };

/** Apply a protocol template (MED-004): returns PROPOSED lines only — never creates
 * requests, so per-patient allergy/override checks can't be bypassed. */
export async function applyRxTemplate(db: D1Database, args: { templateCode: string }): Promise<{ templateCode: string; proposals: RxProposal[] }> {
  const rows = await many<{ medicine_code: string; substance_code: string; dose: string | null; route: string | null; frequency: string | null; duration_days: number | null; quantity: number | null; instructions: string | null }>(
    db, `SELECT medicine_code, substance_code, dose, route, frequency, duration_days, quantity, instructions
         FROM clinical_rx_template_item WHERE template_code=? ORDER BY medicine_code`, [args.templateCode]);
  if (rows.length === 0) throw new PrescribingError(`protocol template not found or empty: ${args.templateCode}`);
  const proposals: RxProposal[] = rows.map((x) => ({
    medicineCode: x.medicine_code,
    substanceCode: x.substance_code,
    ...(x.dose ? { dose: x.dose } : {}),
    ...(x.route ? { route: x.route } : {}),
    ...(x.frequency ? { frequency: x.frequency } : {}),
    ...(x.duration_days === null ? {} : { durationDays: x.duration_days }),
    ...(x.quantity === null ? {} : { quantity: x.quantity }),
    ...(x.instructions ? { instructions: x.instructions } : {}),
    requiresConfirmation: true,
  }));
  return { templateCode: args.templateCode, proposals };
}

export type DueMedicationRow = { requestId: string; patientId: string; mrn: string | null; name: string; medicineCode: string; substanceCode: string; dose: string | null; route: string | null; frequency: string | null; prescribedAt: string };

/** Active medication requests due for administration (MED-09 worklist). Read-only;
 * recording an administration is a separate, audited write, and a not-given dose
 * always requires a reason. */
export async function dueMedications(db: D1Database): Promise<DueMedicationRow[]> {
  const rows = await many<{ id: string; patient_id: string; mrn: string | null; given_name: string; family_name: string; medicine_code: string; substance_code: string; dose: string | null; route: string | null; frequency: string | null; created_at: string }>(
    db,
    `SELECT mr.id, mr.patient_id, p.mrn, p.given_name, p.family_name, mr.medicine_code, mr.substance_code, mr.dose, mr.route, mr.frequency, mr.created_at
       FROM clinical_medication_request mr
       JOIN identity_patient p ON p.id = mr.patient_id
      WHERE mr.status='active'
      ORDER BY mr.created_at ASC`,
  );
  return rows.map((r) => ({
    requestId: r.id, patientId: r.patient_id, mrn: r.mrn, name: `${r.given_name} ${r.family_name}`.trim(),
    medicineCode: r.medicine_code, substanceCode: r.substance_code, dose: r.dose, route: r.route, frequency: r.frequency, prescribedAt: r.created_at,
  }));
}

// --- Medication administration record (MED-009) -----------------------------

export async function recordAdministration(
  db: D1Database,
  args: { requestId: string; performer?: string; dose?: string; route?: string; site?: string; status?: 'given' | 'not_given'; reason?: string; administeredAt?: string },
): Promise<{ id: string }> {
  const status = args.status ?? 'given';
  if (status === 'not_given' && !args.reason?.trim()) throw new PrescribingError('a not-given administration requires a reason');
  const req = await one<{ patient_id: string }>(db, `SELECT patient_id FROM clinical_medication_request WHERE id=?`, [args.requestId]);
  if (!req) throw new PrescribingError('medication request not found');
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_medication_administration (id, request_id, patient_id, administered_at, dose, route, site, performer, status, reason)
              VALUES (?,?,?,COALESCE(?, ${NOW}),?,?,?,?,?,?)`,
      [id, args.requestId, req.patient_id, args.administeredAt ?? null, args.dose ?? null, args.route ?? null, args.site ?? null, args.performer ?? null, status, args.reason ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'create','medication_administration',?,?,'success',?,?)`,
      [uuidv7(), args.performer ?? null, id, req.patient_id, `${status}${args.reason ? ': ' + args.reason : ''}`, 'mar:' + id]),
  ]);
  return { id };
}

export type AdministrationRow = { id: string; administeredAt: string; dose: string | null; route: string | null; site: string | null; status: string; reason: string | null };

export async function listAdministrations(db: D1Database, args: { requestId: string }): Promise<AdministrationRow[]> {
  const rows = await many<{ id: string; administered_at: string; dose: string | null; route: string | null; site: string | null; status: string; reason: string | null }>(
    db, `SELECT id, administered_at, dose, route, site, status, reason FROM clinical_medication_administration WHERE request_id=? ORDER BY administered_at`, [args.requestId]);
  return rows.map((x) => ({ id: x.id, administeredAt: x.administered_at, dose: x.dose, route: x.route, site: x.site, status: x.status, reason: x.reason }));
}
