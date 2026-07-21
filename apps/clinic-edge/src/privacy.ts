/**
 * Privacy-preserving views and authorised disclosure (VIS-009, MGT-009, PAT-010,
 * pack §4.4/§9.3). A public waiting-room screen and an analytical extract carry
 * only de-identified data (domain projections); an authorised patient-summary
 * export is recorded in an append-only disclosure log so a patient can be told
 * who saw their record and why.
 */
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { uuidv7, publicQueueEntry, analyticalRecord, type PublicQueueEntry, type AnalyticalRecord } from '@sancta/domain';

// Namespace for pseudonymisation. Not a secret — it only decouples the analytical
// id from the real patient id so an extract cannot be trivially re-identified.
const PSEUDONYM_NAMESPACE = 'sancta-analytics-v1';

function pseudonymId(patientId: string): string {
  return 'p-' + createHash('sha256').update(PSEUDONYM_NAMESPACE + ':' + patientId).digest('hex').slice(0, 16);
}

/**
 * De-identified public queue for a waiting-room screen (VIS-009). Reads queue
 * tokens/stations/status only — patient identity is never joined, so no PHI can
 * reach the screen. Wait time is derived from the entry's creation.
 */
export async function publicQueue(pool: Pool, asOfIso?: string): Promise<PublicQueueEntry[]> {
  const asOf = asOfIso ? new Date(asOfIso) : new Date();
  const r = await pool.query(
    `SELECT token, station, status, created_at FROM flow.queue_entry WHERE status <> 'done' ORDER BY station, priority, token`,
  );
  return r.rows.map((x) =>
    publicQueueEntry({
      token: 'T' + String(x.token).padStart(3, '0'),
      station: x.station,
      status: x.status,
      waitMinutes: Math.max(0, Math.floor((asOf.getTime() - new Date(x.created_at).getTime()) / 60000)),
    }),
  );
}

/**
 * De-identified analytical extract, separate from the live path (MGT-009). Each
 * patient becomes a pseudonymous record with an age band (never the exact DOB),
 * sex and site. The extract is audited as a bulk export of aggregate data.
 */
export async function analyticalExtract(pool: Pool, args: { asOf: string; exportedBy?: string }): Promise<{ asOf: string; records: AnalyticalRecord[]; rowCount: number }> {
  const r = await pool.query(
    `SELECT id, to_char(date_of_birth,'YYYY-MM-DD') AS dob, sex, site_id FROM identity.patient WHERE deceased = false`,
  );
  const records = r.rows
    .filter((x) => x.dob)
    .map((x) => analyticalRecord({ pseudoId: pseudonymId(x.id), dob: x.dob, sex: x.sex, siteId: x.site_id, asOf: args.asOf }));
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'export','analytical_dataset','success',$3, now(), $4)`,
    [uuidv7(), args.exportedBy ?? null, `de-identified analytical extract as-of ${args.asOf} (${records.length} rows)`, 'analytics:' + uuidv7()],
  );
  return { asOf: args.asOf, records, rowCount: records.length };
}

export class DisclosureError extends Error {}

export type PatientSummary = {
  patient: { id: string; mrn: string | null; name: string; dateOfBirth: string | null; sex: string | null };
  problems: Array<{ code: string | null; display: string | null; certainty: string }>;
  medications: Array<{ medicineCode: string; dose: string | null; route: string | null }>;
};

/**
 * Assemble and disclose an authorised patient summary (PAT-010). The full summary
 * (identified — this is a lawful disclosure to the patient/authorised recipient)
 * is returned AND recorded in the append-only disclosure log with the purpose and
 * a content hash. A purpose is mandatory; the disclosure is also audited.
 */
export async function exportPatientSummary(
  pool: Pool,
  args: { patientId: string; purpose: string; recipient?: string; format?: string; disclosedBy?: string },
): Promise<{ summary: PatientSummary; disclosureId: string; contentHash: string }> {
  if (!args.purpose?.trim()) throw new DisclosureError('a lawful purpose is required to disclose a patient summary');
  const p = await pool.query(
    `SELECT id, mrn, given_name, family_name, to_char(date_of_birth,'YYYY-MM-DD') AS dob, sex FROM identity.patient WHERE id=$1`,
    [args.patientId],
  );
  if (p.rows.length === 0) throw new DisclosureError('patient not found');
  const row = p.rows[0];

  const dx = await pool.query(
    `SELECT DISTINCT ON (code, display) code, display, certainty FROM clinical.diagnosis WHERE patient_id=$1 AND certainty='confirmed' ORDER BY code, display`,
    [args.patientId],
  );
  const meds = await pool.query(
    `SELECT medicine_code, dose, route FROM clinical.medication_request WHERE patient_id=$1 AND status='active' ORDER BY created_at`,
    [args.patientId],
  );

  const summary: PatientSummary = {
    patient: {
      id: row.id,
      mrn: row.mrn,
      name: `${row.given_name ?? ''} ${row.family_name ?? ''}`.trim(),
      dateOfBirth: row.dob,
      sex: row.sex,
    },
    problems: dx.rows.map((x) => ({ code: x.code, display: x.display, certainty: x.certainty })),
    medications: meds.rows.map((x) => ({ medicineCode: x.medicine_code, dose: x.dose, route: x.route })),
  };

  const contentHash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  const disclosureId = uuidv7();
  await pool.query(
    `INSERT INTO clinical.patient_summary_disclosure (id, patient_id, disclosed_by, purpose, recipient, format, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [disclosureId, args.patientId, args.disclosedBy ?? null, args.purpose, args.recipient ?? null, args.format ?? 'print', contentHash],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'export','patient_summary',$3,$4,'success',$5, now(), $6)`,
    [uuidv7(), args.disclosedBy ?? null, disclosureId, args.patientId, `disclosed for: ${args.purpose}`, 'disclosure:' + disclosureId],
  );
  return { summary, disclosureId, contentHash };
}

/** Disclosure history for a patient's summary exports (PAT-010). */
export async function listPatientDisclosures(pool: Pool, args: { patientId: string }): Promise<Array<{ id: string; purpose: string; recipient: string | null; format: string; disclosedAt: string }>> {
  const r = await pool.query(
    `SELECT id, purpose, recipient, format, to_char(disclosed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS disclosed_at
     FROM clinical.patient_summary_disclosure WHERE patient_id=$1 ORDER BY disclosed_at DESC`,
    [args.patientId],
  );
  return r.rows.map((x) => ({ id: x.id, purpose: x.purpose, recipient: x.recipient, format: x.format, disclosedAt: x.disclosed_at }));
}
