/**
 * Triage / vitals capture on D1 (TRI-001..008, UAT-03). Opens a triage visit +
 * draft encounter, records validated vitals (implausible values are confirmed,
 * never dropped), computes danger signs + early-warning score from the captured
 * vitals, and runs the sign/hand-off + queue. Ported from the Postgres edge
 * `triage.ts`; the domain validators are reused unchanged.
 *
 * D1 translations: interactive tx → db.batch(); FOR UPDATE → status-guarded write;
 * DISTINCT ON (kind) → a ROW_NUMBER() window; jsonb_array_length → json_array_length.
 */
import { uuidv7, validateVitals, detectDangerSigns, earlyWarningScore, type VitalInput, type VitalValidation, type VitalKind, type VitalReading, type DangerSign, type EarlyWarning } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class TriageError extends Error {}

export type RecordVitalsBody = { patientId: string; vitals: VitalInput[]; confirmed?: boolean; user?: string; site?: string };
export type RecordVitalsResult = { encounterId: string; visitId: string; observations: VitalValidation[] };

/** Validate + persist a vitals set atomically. Throws before any write if an
 * implausible value is submitted without confirmation (the caller re-presents it). */
export async function recordVitals(db: D1Database, body: RecordVitalsBody): Promise<RecordVitalsResult> {
  const results = validateVitals(body.vitals, body.confirmed === undefined ? {} : { confirmed: body.confirmed });
  const visitId = uuidv7();
  const encounterId = uuidv7();
  const batch = [
    stmt(db, `INSERT INTO flow_visit (id, patient_id, visit_number, site_id, status) VALUES (?,?,?,?,'in_triage')`, [visitId, body.patientId, 'V-' + visitId.slice(-12), body.site ?? null]),
    stmt(db, `INSERT INTO clinical_encounter (id, visit_id, patient_id, status, form_version) VALUES (?,?,?,'draft',1)`, [encounterId, visitId, body.patientId]),
    ...results.map((r) => stmt(db,
      `INSERT INTO clinical_observation (id, encounter_id, patient_id, kind, value, unit, flag, confirmed, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuidv7(), encounterId, body.patientId, r.kind, r.value, r.unit ?? null, r.flag, r.requiresConfirmation ? (body.confirmed ? 1 : 0) : 0, body.user ?? null])),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'create','triage',?,?,'success',?,?)`, [uuidv7(), body.user ?? null, encounterId, body.patientId, `${results.length} observations`, 'triage:' + encounterId]),
  ];
  await db.batch(batch);
  return { encounterId, visitId, observations: results };
}

/** Latest reading per vital kind for an encounter (DISTINCT ON via ROW_NUMBER). */
async function latestReadings(db: D1Database, encounterId: string): Promise<VitalReading[]> {
  const rows = await many<{ kind: string; value: number }>(
    db,
    `SELECT kind, value FROM (
       SELECT kind, value, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY recorded_at DESC) AS rn
       FROM clinical_observation WHERE encounter_id=?
     ) WHERE rn=1`,
    [encounterId],
  );
  return rows.map((x) => ({ kind: x.kind as VitalKind, value: Number(x.value) }));
}

export type TriageAssessmentBody = {
  encounterId: string; reason?: string; symptoms?: string[]; painScore?: number;
  allergyReviewed?: boolean; infectionScreen?: Record<string, unknown>; user?: string;
};
export type TriageAssessmentResult = { assessmentId: string; dangerSigns: DangerSign[]; ews: EarlyWarning };

/** Record the triage assessment; danger signs + EWS are computed from captured
 * vitals and stored (decision support, never diagnosis). One per encounter. */
export async function recordTriageAssessment(db: D1Database, body: TriageAssessmentBody): Promise<TriageAssessmentResult> {
  if (body.painScore !== undefined && (body.painScore < 0 || body.painScore > 10)) throw new TriageError('pain score must be 0–10');
  const enc = await one<{ patient_id: string }>(db, `SELECT patient_id FROM clinical_encounter WHERE id=?`, [body.encounterId]);
  if (!enc) throw new TriageError('encounter not found');
  const readings = await latestReadings(db, body.encounterId);
  const dangerSigns = detectDangerSigns(readings);
  const ews = earlyWarningScore(readings);
  const assessmentId = uuidv7();
  await db.batch([
    stmt(db,
      `INSERT INTO clinical_triage_assessment
         (id, encounter_id, patient_id, reason, symptoms, pain_score, allergy_reviewed, infection_screen, danger_signs, ews_score, ews_band, ews_version, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)
       ON CONFLICT(encounter_id) DO UPDATE SET
         reason=excluded.reason, symptoms=excluded.symptoms, pain_score=excluded.pain_score, allergy_reviewed=excluded.allergy_reviewed,
         infection_screen=excluded.infection_screen, danger_signs=excluded.danger_signs, ews_score=excluded.ews_score, ews_band=excluded.ews_band, ews_version=excluded.ews_version`,
      [assessmentId, body.encounterId, enc.patient_id, body.reason ?? null, JSON.stringify(body.symptoms ?? []), body.painScore ?? null,
       body.allergyReviewed ? 1 : 0, JSON.stringify(body.infectionScreen ?? {}), JSON.stringify(dangerSigns), ews.score, ews.band, ews.ruleVersion, body.user ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'create','triage_assessment',?,?,'success',?,?)`,
      [uuidv7(), body.user ?? null, body.encounterId, enc.patient_id, `EWS ${ews.score} (${ews.band}); ${dangerSigns.length} danger sign(s)`, 'triage-assess:' + body.encounterId]),
  ]);
  return { assessmentId, dangerSigns, ews };
}

export type InterventionBody = { encounterId: string; kind: string; detail?: string; medication?: string; response?: string; user?: string };

/** Record a nursing intervention and the patient's response (TRI-006). */
export async function recordIntervention(db: D1Database, body: InterventionBody): Promise<{ interventionId: string }> {
  if (!body.kind?.trim()) throw new TriageError('an intervention kind is required');
  const enc = await one<{ patient_id: string }>(db, `SELECT patient_id FROM clinical_encounter WHERE id=?`, [body.encounterId]);
  if (!enc) throw new TriageError('encounter not found');
  const interventionId = uuidv7();
  await db.prepare(`INSERT INTO clinical_triage_intervention (id, encounter_id, patient_id, kind, detail, medication, response, performed_by) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(interventionId, body.encounterId, enc.patient_id, body.kind, body.detail ?? null, body.medication ?? null, body.response ?? null, body.user ?? null).run();
  return { interventionId };
}

/** Sign the triage and hand off (TRI-008). The visit leaves the queue only when signed. */
export async function signTriage(db: D1Database, args: { encounterId: string; signedBy: string }): Promise<{ status: 'signed' }> {
  if (!args.signedBy) throw new TriageError('a signer is required');
  const a = await one<{ status: string }>(db, `SELECT status FROM clinical_triage_assessment WHERE encounter_id=?`, [args.encounterId]);
  if (!a) throw new TriageError('no triage assessment to sign');
  if (a.status === 'signed') throw new TriageError('triage is already signed');
  await db.batch([
    stmt(db, `UPDATE clinical_triage_assessment SET status='signed', signed_by=?, signed_at=${NOW} WHERE encounter_id=? AND status='draft'`, [args.signedBy, args.encounterId]),
    stmt(db, `UPDATE flow_visit SET status='triaged' WHERE id=(SELECT visit_id FROM clinical_encounter WHERE id=?)`, [args.encounterId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, event_hash)
              VALUES (?,?,'sign','triage_assessment',?,'success',?)`, [uuidv7(), args.signedBy, args.encounterId, 'triage-sign:' + args.encounterId]),
  ]);
  return { status: 'signed' };
}

export type TriageQueueRow = { encounterId: string; visitId: string; patientId: string; ewsScore: number | null; ewsBand: string | null; dangerCount: number };

/** Unsigned triage assessments — the triage work queue (TRI-008). Highest EWS first. */
export async function openTriageQueue(db: D1Database): Promise<TriageQueueRow[]> {
  const rows = await many<{ encounter_id: string; visit_id: string; patient_id: string; ews_score: number | null; ews_band: string | null; danger_count: number }>(
    db,
    `SELECT t.encounter_id, e.visit_id, t.patient_id, t.ews_score, t.ews_band, json_array_length(t.danger_signs) AS danger_count
     FROM clinical_triage_assessment t JOIN clinical_encounter e ON e.id=t.encounter_id
     WHERE t.status='draft' ORDER BY COALESCE(t.ews_score,0) DESC, t.created_at ASC`,
  );
  return rows.map((x) => ({ encounterId: x.encounter_id, visitId: x.visit_id, patientId: x.patient_id, ewsScore: x.ews_score, ewsBand: x.ews_band, dangerCount: Number(x.danger_count) }));
}

export type TriageSummary = {
  assessment: Record<string, unknown> | null;
  interventions: Array<{ kind: string; detail: string | null; medication: string | null; response: string | null; at: string }>;
  trend: Record<string, Array<{ value: number; flag: string; at: string }>>;
};

/** Full triage picture incl. repeat-observation trend within the encounter (TRI-007). */
export async function triageSummary(db: D1Database, encounterId: string): Promise<TriageSummary> {
  const assessment = await one<Record<string, unknown>>(
    db, `SELECT reason, symptoms, pain_score, allergy_reviewed, infection_screen, danger_signs, ews_score, ews_band, ews_version, status FROM clinical_triage_assessment WHERE encounter_id=?`, [encounterId]);
  const iv = await many<{ kind: string; detail: string | null; medication: string | null; response: string | null; at: string }>(
    db, `SELECT kind, detail, medication, response, performed_at AS at FROM clinical_triage_intervention WHERE encounter_id=? ORDER BY performed_at`, [encounterId]);
  const obs = await many<{ kind: string; value: number; flag: string; at: string }>(
    db, `SELECT kind, value, flag, recorded_at AS at FROM clinical_observation WHERE encounter_id=? ORDER BY recorded_at`, [encounterId]);
  const trend: TriageSummary['trend'] = {};
  for (const o of obs) (trend[o.kind] ??= []).push({ value: Number(o.value), flag: o.flag, at: o.at });
  return {
    assessment: assessment ?? null,
    interventions: iv.map((x) => ({ kind: x.kind, detail: x.detail, medication: x.medication, response: x.response, at: x.at })),
    trend,
  };
}
