/**
 * Prescribing with allergy checking and controlled override (MED-002/003, UAT-05).
 * A medication request is checked against the patient's active allergies by
 * substance code; a match blocks the prescription unless an authorised prescriber
 * supplies an override reason, which is recorded on the request and audited. The
 * alert source and severity are always visible.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class PrescribingError extends Error {}

export async function recordAllergy(pool: Pool, args: { patientId: string; substanceCode: string; severity?: 'low' | 'high' | 'critical' }): Promise<{ allergyId: string }> {
  const allergyId = uuidv7();
  await pool.query(`INSERT INTO clinical.allergy (id, patient_id, substance_code, severity) VALUES ($1,$2,$3,$4)`, [
    allergyId,
    args.patientId,
    args.substanceCode,
    args.severity ?? 'high',
  ]);
  return { allergyId };
}

export type AllergyAlert = { substanceCode: string; severity: string };

export type PrescribeBody = {
  patientId: string;
  encounterId?: string;
  medicineCode: string;
  substanceCode: string;
  dose?: string;
  route?: string;
  frequency?: string;
  durationDays?: number;
  quantity?: number;
  instructions?: string;
  prescribedBy: string;
  override?: boolean;
  overrideReason?: string;
};

export type PrescribeResult =
  | { ok: true; requestId: string; overridden: boolean }
  | { ok: false; alerts: AllergyAlert[] };

/**
 * Create a medication request. If the medicine's substance matches an active
 * allergy, block unless overridden with a reason (MED-003). Override requires the
 * prescriber's reason and is recorded (signature = prescribedBy) and audited.
 */
export async function prescribe(pool: Pool, body: PrescribeBody): Promise<PrescribeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const allergies = await client.query(`SELECT substance_code, severity FROM clinical.allergy WHERE patient_id=$1 AND substance_code=$2`, [
      body.patientId,
      body.substanceCode,
    ]);
    const alerts: AllergyAlert[] = allergies.rows.map((r) => ({ substanceCode: r.substance_code, severity: r.severity }));

    if (alerts.length > 0 && !body.override) {
      await client.query('ROLLBACK');
      return { ok: false, alerts };
    }
    if (alerts.length > 0 && body.override && !body.overrideReason) {
      await client.query('ROLLBACK');
      throw new PrescribingError('overriding an allergy alert requires a reason');
    }

    const requestId = uuidv7();
    await client.query(
      `INSERT INTO clinical.medication_request (id, patient_id, encounter_id, medicine_code, substance_code, dose, route, frequency, duration_days, quantity, instructions, status, prescribed_by, override_reason, override_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14)`,
      [
        requestId,
        body.patientId,
        body.encounterId ?? null,
        body.medicineCode,
        body.substanceCode,
        body.dose ?? null,
        body.route ?? null,
        body.frequency ?? null,
        body.durationDays ?? null,
        body.quantity ?? null,
        body.instructions ?? null,
        body.prescribedBy,
        alerts.length > 0 ? body.overrideReason ?? null : null,
        alerts.length > 0 ? body.prescribedBy : null,
      ],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','medication_request',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), body.prescribedBy, requestId, body.patientId, alerts.length > 0 ? 'allergy override: ' + body.overrideReason : 'prescribed', 'rx:' + requestId],
    );
    await client.query('COMMIT');
    return { ok: true, requestId, overridden: alerts.length > 0 };
  } catch (e) {
    if (e instanceof PrescribingError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Protocol templates / favourites (MED-004) ------------------------------

export type RxTemplateItem = {
  medicineCode: string;
  substanceCode: string;
  dose?: string;
  route?: string;
  frequency?: string;
  durationDays?: number;
  quantity?: number;
  instructions?: string;
};

/** Define/replace a reusable prescribing protocol/favourite (MED-004). */
export async function defineRxTemplate(pool: Pool, args: { code: string; name: string; items: RxTemplateItem[] }): Promise<{ code: string; itemCount: number }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new PrescribingError('template code and name are required');
  if (!args.items?.length) throw new PrescribingError('a protocol template needs at least one item');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO clinical.rx_template (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=$2, active=true`, [args.code, args.name]);
    await client.query(`DELETE FROM clinical.rx_template_item WHERE template_code=$1`, [args.code]);
    for (const it of args.items) {
      await client.query(
        `INSERT INTO clinical.rx_template_item (id, template_code, medicine_code, substance_code, dose, route, frequency, duration_days, quantity, instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), args.code, it.medicineCode, it.substanceCode, it.dose ?? null, it.route ?? null, it.frequency ?? null, it.durationDays ?? null, it.quantity ?? null, it.instructions ?? null],
      );
    }
    await client.query('COMMIT');
    return { code: args.code, itemCount: args.items.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type RxProposal = RxTemplateItem & { requiresConfirmation: true };

/**
 * Apply a protocol template (MED-004). Returns PROPOSED lines only — it does NOT
 * create medication requests. Each proposal must be confirmed via `prescribe`,
 * which runs the allergy/override safety, so a template can never bypass per-
 * patient prescribing checks.
 */
export async function applyRxTemplate(pool: Pool, args: { templateCode: string }): Promise<{ templateCode: string; proposals: RxProposal[] }> {
  const r = await pool.query(
    `SELECT medicine_code, substance_code, dose, route, frequency, duration_days, quantity, instructions
     FROM clinical.rx_template_item WHERE template_code=$1 ORDER BY medicine_code`,
    [args.templateCode],
  );
  if (r.rows.length === 0) throw new PrescribingError(`protocol template not found or empty: ${args.templateCode}`);
  const proposals: RxProposal[] = r.rows.map((x) => ({
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

// --- Medication administration record (MED-009) -----------------------------

export type DueMedicationRow = { requestId: string; patientId: string; mrn: string | null; name: string; medicineCode: string; substanceCode: string; dose: string | null; route: string | null; frequency: string | null; prescribedAt: string };

/** Active medication requests due for administration (MED-09 worklist). Read-only. */
export async function dueMedications(pool: Pool): Promise<DueMedicationRow[]> {
  const res = await pool.query(
    `SELECT mr.id, mr.patient_id, p.mrn, p.given_name, p.family_name, mr.medicine_code, mr.substance_code, mr.dose, mr.route, mr.frequency,
            to_char(mr.created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS prescribed_at
       FROM clinical.medication_request mr
       JOIN identity.patient p ON p.id = mr.patient_id
      WHERE mr.status='active'
      ORDER BY mr.created_at ASC`,
  );
  return res.rows.map((r) => ({
    requestId: r.id, patientId: r.patient_id, mrn: r.mrn, name: `${r.given_name} ${r.family_name}`.trim(),
    medicineCode: r.medicine_code, substanceCode: r.substance_code, dose: r.dose, route: r.route, frequency: r.frequency, prescribedAt: r.prescribed_at,
  }));
}

/**
 * Record a medicine administration against a request (MED-009). Captures time,
 * dose, route, site, performer and the given/not-given outcome. A not-given event
 * must carry a reason (enforced by a CHECK). Append-only.
 */
export async function recordAdministration(
  pool: Pool,
  args: { requestId: string; performer?: string; dose?: string; route?: string; site?: string; status?: 'given' | 'not_given'; reason?: string; administeredAt?: string },
): Promise<{ id: string }> {
  const status = args.status ?? 'given';
  if (status === 'not_given' && !args.reason?.trim()) throw new PrescribingError('a not-given administration requires a reason');
  const req = await pool.query(`SELECT patient_id FROM clinical.medication_request WHERE id=$1`, [args.requestId]);
  if (req.rows.length === 0) throw new PrescribingError('medication request not found');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO clinical.medication_administration (id, request_id, patient_id, administered_at, dose, route, site, performer, status, reason)
     VALUES ($1,$2,$3,COALESCE($4, now()),$5,$6,$7,$8,$9,$10)`,
    [id, args.requestId, req.rows[0].patient_id, args.administeredAt ?? null, args.dose ?? null, args.route ?? null, args.site ?? null, args.performer ?? null, status, args.reason ?? null],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'create','medication_administration',$3,$4,'success',$5, now(), $6)`,
    [uuidv7(), args.performer ?? null, id, req.rows[0].patient_id, `${status}${args.reason ? ': ' + args.reason : ''}`, 'mar:' + id],
  );
  return { id };
}

export type AdministrationRow = { id: string; administeredAt: string; dose: string | null; route: string | null; site: string | null; status: string; reason: string | null };

/** Administration history for a medication request, oldest first (MED-009). */
export async function listAdministrations(pool: Pool, args: { requestId: string }): Promise<AdministrationRow[]> {
  const r = await pool.query(
    `SELECT id, to_char(administered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS administered_at, dose, route, site, status, reason
     FROM clinical.medication_administration WHERE request_id=$1 ORDER BY administered_at`,
    [args.requestId],
  );
  return r.rows.map((x) => ({ id: x.id, administeredAt: x.administered_at, dose: x.dose, route: x.route, site: x.site, status: x.status, reason: x.reason }));
}
