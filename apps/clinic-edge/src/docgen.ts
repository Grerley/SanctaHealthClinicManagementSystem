/**
 * Clinical document assembly (EHR-011). Loads captured edge data and feeds the
 * pure domain generators to produce a structured document (the caller renders or
 * stores it). Read-only assembly; the source records remain the system of record.
 */
import type { Pool } from 'pg';
import { visitSummary, prescriptionDoc, sickNote, referralLetter, type ClinicalDocument, type PatientRef, DocGenError } from '@sancta/domain';

async function patientRef(pool: Pool, patientId: string): Promise<PatientRef> {
  const r = await pool.query(`SELECT id, mrn, given_name, family_name FROM identity.patient WHERE id=$1`, [patientId]);
  if (r.rowCount === 0) throw new DocGenError('patient not found');
  const p = r.rows[0];
  return { id: p.id, mrn: p.mrn, name: `${p.family_name ?? ''}, ${p.given_name ?? ''}`.trim() };
}

const TODAY = () => new Date().toISOString().slice(0, 10);

/** Visit summary from an encounter's diagnoses + triage reason + plan (EHR-011). */
export async function generateVisitSummary(pool: Pool, args: { encounterId: string; clinician: string; date?: string }): Promise<ClinicalDocument> {
  const enc = await pool.query(`SELECT patient_id, content FROM clinical.encounter WHERE id=$1`, [args.encounterId]);
  if (enc.rowCount === 0) throw new DocGenError('encounter not found');
  const patient = await patientRef(pool, enc.rows[0].patient_id);
  const dx = await pool.query(`SELECT display, certainty FROM clinical.diagnosis WHERE encounter_id=$1 ORDER BY rank`, [args.encounterId]);
  const reason = (await pool.query(`SELECT reason FROM clinical.triage_assessment WHERE encounter_id=$1`, [args.encounterId])).rows[0]?.reason;
  const plan = (enc.rows[0].content as { plan?: string } | null)?.plan;
  return visitSummary({
    patient, date: args.date ?? TODAY(), clinician: args.clinician,
    ...(reason ? { reason } : {}),
    diagnoses: dx.rows.map((d) => ({ display: d.display ?? '', certainty: d.certainty })),
    ...(plan ? { plan } : {}),
  });
}

export async function generatePrescription(pool: Pool, args: { patientId: string; prescriber: string; items: Array<{ drug: string; dose: string; frequency: string; duration: string }>; date?: string }): Promise<ClinicalDocument> {
  return prescriptionDoc({ patient: await patientRef(pool, args.patientId), date: args.date ?? TODAY(), prescriber: args.prescriber, items: args.items });
}

export async function generateSickNote(pool: Pool, args: { patientId: string; from: string; to: string; reason: string; clinician: string }): Promise<ClinicalDocument> {
  return sickNote({ patient: await patientRef(pool, args.patientId), from: args.from, to: args.to, reason: args.reason, clinician: args.clinician });
}

export async function generateReferral(pool: Pool, args: { patientId: string; referrer: string; referTo: string; reason: string; findings?: string; date?: string }): Promise<ClinicalDocument> {
  return referralLetter({ patient: await patientRef(pool, args.patientId), date: args.date ?? TODAY(), referrer: args.referrer, referTo: args.referTo, reason: args.reason, ...(args.findings ? { findings: args.findings } : {}) });
}
