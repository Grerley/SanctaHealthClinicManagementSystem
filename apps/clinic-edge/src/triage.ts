/**
 * Triage / vitals capture on the edge (TRI-002/003, UAT-03). Opens a triage
 * visit + draft encounter for a patient and records a validated set of vitals.
 * Implausible values must be confirmed (not silently dropped); the recorded row
 * keeps the value and its flag so the timeline shows what was entered and that it
 * was confirmed.
 */
import type { Pool } from 'pg';
import { uuidv7, validateVitals, detectDangerSigns, earlyWarningScore, type VitalInput, type VitalValidation, type VitalKind, type VitalReading, type DangerSign, type EarlyWarning } from '@sancta/domain';

const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';

export class TriageError extends Error {}

export type RecordVitalsBody = {
  patientId: string;
  vitals: VitalInput[];
  confirmed?: boolean;
  user?: string;
  site?: string;
};

export type RecordVitalsResult = {
  encounterId: string;
  visitId: string;
  observations: VitalValidation[];
};

/**
 * Validate and persist a vitals set atomically. Throws (VitalError) if an
 * implausible value is submitted without confirmation — the caller re-presents it
 * for confirmation rather than losing the data.
 */
export async function recordVitals(pool: Pool, body: RecordVitalsBody): Promise<RecordVitalsResult> {
  // Domain validation first — may throw before any write.
  const results = validateVitals(body.vitals, body.confirmed === undefined ? {} : { confirmed: body.confirmed });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const visitId = uuidv7();
    const encounterId = uuidv7();
    const site = body.site ?? DEFAULT_SITE;
    await client.query(`INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status) VALUES ($1,$2,$3,$4,'in_triage')`, [
      visitId,
      body.patientId,
      'V-' + visitId.slice(-12),
      site,
    ]);
    await client.query(
      `INSERT INTO clinical.encounter (id, visit_id, patient_id, status, form_version) VALUES ($1,$2,$3,'draft',1)`,
      [encounterId, visitId, body.patientId],
    );
    for (const r of results) {
      await client.query(
        `INSERT INTO clinical.observation (id, encounter_id, patient_id, kind, value, unit, flag, confirmed, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), encounterId, body.patientId, r.kind, r.value, r.unit, r.flag, r.requiresConfirmation ? Boolean(body.confirmed) : false, body.user ?? null],
      );
    }
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','triage',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), body.user ?? null, encounterId, body.patientId, `${results.length} observations`, 'triage:' + encounterId],
    );
    await client.query('COMMIT');
    return { encounterId, visitId, observations: results };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Latest reading per vital kind for an encounter, mapped to domain readings. */
async function latestReadings(pool: Pool, encounterId: string): Promise<VitalReading[]> {
  const r = await pool.query(
    `SELECT DISTINCT ON (kind) kind, value FROM clinical.observation
     WHERE encounter_id=$1 ORDER BY kind, recorded_at DESC`,
    [encounterId],
  );
  return r.rows.map((x) => ({ kind: x.kind as VitalKind, value: Number(x.value) }));
}

export type TriageAssessmentBody = {
  encounterId: string;
  reason?: string;
  symptoms?: string[];
  painScore?: number;
  allergyReviewed?: boolean;
  infectionScreen?: Record<string, unknown>;
  user?: string;
};

export type TriageAssessmentResult = { assessmentId: string; dangerSigns: DangerSign[]; ews: EarlyWarning };

/**
 * Record the triage assessment (TRI-001): reason, symptoms, pain, allergy review
 * and infection screen. Danger signs (TRI-005) and the early-warning score
 * (TRI-004) are computed from the encounter's captured vitals and stored for
 * visibility — decision support, never a diagnosis. One assessment per encounter.
 */
export async function recordTriageAssessment(pool: Pool, body: TriageAssessmentBody): Promise<TriageAssessmentResult> {
  if (body.painScore !== undefined && (body.painScore < 0 || body.painScore > 10)) throw new TriageError('pain score must be 0–10');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const enc = await client.query(`SELECT patient_id FROM clinical.encounter WHERE id=$1 FOR UPDATE`, [body.encounterId]);
    if (enc.rowCount === 0) throw new TriageError('encounter not found');
    const patientId = enc.rows[0].patient_id;

    const readings = await latestReadings(pool, body.encounterId);
    const dangerSigns = detectDangerSigns(readings);
    const ews = earlyWarningScore(readings);

    const assessmentId = uuidv7();
    await client.query(
      `INSERT INTO clinical.triage_assessment
         (id, encounter_id, patient_id, reason, symptoms, pain_score, allergy_reviewed, infection_screen, danger_signs, ews_score, ews_band, ews_version, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13)
       ON CONFLICT (encounter_id) DO UPDATE SET
         reason=$4, symptoms=$5, pain_score=$6, allergy_reviewed=$7, infection_screen=$8,
         danger_signs=$9, ews_score=$10, ews_band=$11, ews_version=$12`,
      [assessmentId, body.encounterId, patientId, body.reason ?? null, JSON.stringify(body.symptoms ?? []), body.painScore ?? null,
       body.allergyReviewed ?? false, JSON.stringify(body.infectionScreen ?? {}), JSON.stringify(dangerSigns), ews.score, ews.band, ews.ruleVersion, body.user ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','triage_assessment',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), body.user ?? null, body.encounterId, patientId, `EWS ${ews.score} (${ews.band}); ${dangerSigns.length} danger sign(s)`, 'triage-assess:' + body.encounterId],
    );
    await client.query('COMMIT');
    return { assessmentId, dangerSigns, ews };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type InterventionBody = { encounterId: string; kind: string; detail?: string; medication?: string; response?: string; user?: string };

/** Record a nursing intervention and the patient's response (TRI-006). */
export async function recordIntervention(pool: Pool, body: InterventionBody): Promise<{ interventionId: string }> {
  if (!body.kind?.trim()) throw new TriageError('an intervention kind is required');
  const enc = await pool.query(`SELECT patient_id FROM clinical.encounter WHERE id=$1`, [body.encounterId]);
  if (enc.rowCount === 0) throw new TriageError('encounter not found');
  const interventionId = uuidv7();
  await pool.query(
    `INSERT INTO clinical.triage_intervention (id, encounter_id, patient_id, kind, detail, medication, response, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [interventionId, body.encounterId, enc.rows[0].patient_id, body.kind, body.detail ?? null, body.medication ?? null, body.response ?? null, body.user ?? null],
  );
  return { interventionId };
}

/**
 * Sign the triage and hand off (TRI-008). The visit moves out of the triage queue
 * only when signed; an unsigned triage stays in the queue. Requires an assessment.
 */
export async function signTriage(pool: Pool, args: { encounterId: string; signedBy: string }): Promise<{ status: 'signed' }> {
  if (!args.signedBy) throw new TriageError('a signer is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query(`SELECT status FROM clinical.triage_assessment WHERE encounter_id=$1 FOR UPDATE`, [args.encounterId]);
    if (a.rowCount === 0) throw new TriageError('no triage assessment to sign');
    if (a.rows[0].status === 'signed') throw new TriageError('triage is already signed');
    await client.query(`UPDATE clinical.triage_assessment SET status='signed', signed_by=$2, signed_at=now() WHERE encounter_id=$1`, [args.encounterId, args.signedBy]);
    await client.query(`UPDATE flow.visit SET status='triaged' WHERE id=(SELECT visit_id FROM clinical.encounter WHERE id=$1)`, [args.encounterId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, captured_at, event_hash)
       VALUES ($1,$2,'sign','triage_assessment',$3,'success', now(), $4)`,
      [uuidv7(), args.signedBy, args.encounterId, 'triage-sign:' + args.encounterId],
    );
    await client.query('COMMIT');
    return { status: 'signed' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type TriageQueueRow = { encounterId: string; visitId: string; patientId: string; ewsScore: number | null; ewsBand: string | null; dangerCount: number };

/** Unsigned triage assessments — the triage work queue (TRI-008). Highest EWS first. */
export async function openTriageQueue(pool: Pool): Promise<TriageQueueRow[]> {
  const r = await pool.query(
    `SELECT t.encounter_id, e.visit_id, t.patient_id, t.ews_score, t.ews_band, jsonb_array_length(t.danger_signs) AS danger_count
     FROM clinical.triage_assessment t JOIN clinical.encounter e ON e.id=t.encounter_id
     WHERE t.status='draft' ORDER BY coalesce(t.ews_score,0) DESC, t.created_at ASC`,
  );
  return r.rows.map((x) => ({ encounterId: x.encounter_id, visitId: x.visit_id, patientId: x.patient_id, ewsScore: x.ews_score, ewsBand: x.ews_band, dangerCount: Number(x.danger_count) }));
}

export type TriageSummary = {
  assessment: Record<string, unknown> | null;
  interventions: Array<{ kind: string; detail: string | null; medication: string | null; response: string | null; at: string }>;
  trend: Record<string, Array<{ value: number; flag: string; at: string }>>;
};

/** Full triage picture incl. repeat-observation trend within the encounter (TRI-007). */
export async function triageSummary(pool: Pool, encounterId: string): Promise<TriageSummary> {
  const a = await pool.query(`SELECT reason, symptoms, pain_score, allergy_reviewed, infection_screen, danger_signs, ews_score, ews_band, ews_version, status FROM clinical.triage_assessment WHERE encounter_id=$1`, [encounterId]);
  const iv = await pool.query(`SELECT kind, detail, medication, response, to_char(performed_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM clinical.triage_intervention WHERE encounter_id=$1 ORDER BY performed_at`, [encounterId]);
  const obs = await pool.query(`SELECT kind, value, flag, to_char(recorded_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM clinical.observation WHERE encounter_id=$1 ORDER BY recorded_at`, [encounterId]);
  const trend: TriageSummary['trend'] = {};
  for (const o of obs.rows) (trend[o.kind] ??= []).push({ value: Number(o.value), flag: o.flag, at: o.at });
  return {
    assessment: a.rows[0] ?? null,
    interventions: iv.rows.map((x) => ({ kind: x.kind, detail: x.detail, medication: x.medication, response: x.response, at: x.at })),
    trend,
  };
}
