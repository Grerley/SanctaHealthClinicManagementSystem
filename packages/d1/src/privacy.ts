/**
 * Privacy-preserving views and authorised disclosure on D1 (VIS-009, MGT-009,
 * PAT-010, §4.4/§9.3). A public waiting-room screen and an analytical extract
 * carry only de-identified data (domain projections); an authorised patient-
 * summary export is recorded in an append-only disclosure log so a patient can be
 * told who saw their record and why. Ported from the Postgres edge `privacy.ts`.
 *
 * D1 translations: node:crypto createHash → Web Crypto SHA-256 (barrel stays
 * node-free); DISTINCT ON → GROUP BY; boolean deceased → INTEGER 0/1.
 */
import { uuidv7, publicQueueEntry, analyticalRecord, type PublicQueueEntry, type AnalyticalRecord } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

// Namespace for pseudonymisation. Not a secret — it only decouples the analytical
// id from the real patient id so an extract cannot be trivially re-identified.
const PSEUDONYM_NAMESPACE = 'sancta-analytics-v1';

async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pseudonymId(patientId: string): Promise<string> {
  return 'p-' + (await sha256Hex(PSEUDONYM_NAMESPACE + ':' + patientId)).slice(0, 16);
}

/**
 * De-identified public queue for a waiting-room screen (VIS-009). Reads queue
 * tokens/stations/status only — patient identity is never joined, so no PHI can
 * reach the screen. Wait time is derived from the entry's creation.
 */
export async function publicQueue(db: D1Database, asOfIso?: string): Promise<PublicQueueEntry[]> {
  const asOf = asOfIso ? new Date(asOfIso) : new Date();
  const rows = await many<{ token: number; station: string | null; status: string; created_at: string }>(db,
    `SELECT token, station, status, created_at FROM flow_queue_entry WHERE status <> 'done' ORDER BY station, priority, token`);
  return rows.map((x) =>
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
export async function analyticalExtract(db: D1Database, args: { asOf: string; exportedBy?: string }): Promise<{ asOf: string; records: AnalyticalRecord[]; rowCount: number }> {
  const rows = await many<{ id: string; dob: string | null; sex: string | null; site_id: string | null }>(db,
    `SELECT id, date_of_birth AS dob, sex, site_id FROM identity_patient WHERE deceased = 0`);
  const records: AnalyticalRecord[] = [];
  for (const x of rows) {
    if (!x.dob) continue;
    records.push(analyticalRecord({ pseudoId: await pseudonymId(x.id), dob: x.dob, sex: x.sex, siteId: x.site_id, asOf: args.asOf }));
  }
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, outcome, reason, event_hash) VALUES (?,?,'export','analytical_dataset','success',?,?)`)
    .bind(uuidv7(), args.exportedBy ?? null, `de-identified analytical extract as-of ${args.asOf} (${records.length} rows)`, 'analytics:' + uuidv7()).run();
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
 * (identified — a lawful disclosure to the patient/authorised recipient) is
 * returned AND recorded in the append-only disclosure log with the purpose and a
 * content hash. A purpose is mandatory; the disclosure is also audited.
 */
export async function exportPatientSummary(
  db: D1Database,
  args: { patientId: string; purpose: string; recipient?: string; format?: string; disclosedBy?: string },
): Promise<{ summary: PatientSummary; disclosureId: string; contentHash: string }> {
  if (!args.purpose?.trim()) throw new DisclosureError('a lawful purpose is required to disclose a patient summary');
  const row = await one<{ id: string; mrn: string | null; given_name: string | null; family_name: string | null; dob: string | null; sex: string | null }>(db,
    `SELECT id, mrn, given_name, family_name, date_of_birth AS dob, sex FROM identity_patient WHERE id=?`, [args.patientId]);
  if (!row) throw new DisclosureError('patient not found');

  const dx = await many<{ code: string | null; display: string | null; certainty: string }>(db,
    `SELECT code, display, MAX(certainty) AS certainty FROM clinical_diagnosis WHERE patient_id=? AND certainty='confirmed' GROUP BY code, display ORDER BY code, display`, [args.patientId]);
  const meds = await many<{ medicine_code: string; dose: string | null; route: string | null }>(db,
    `SELECT medicine_code, dose, route FROM clinical_medication_request WHERE patient_id=? AND status='active' ORDER BY created_at`, [args.patientId]);

  const summary: PatientSummary = {
    patient: { id: row.id, mrn: row.mrn, name: `${row.given_name ?? ''} ${row.family_name ?? ''}`.trim(), dateOfBirth: row.dob, sex: row.sex },
    problems: dx.map((x) => ({ code: x.code, display: x.display, certainty: x.certainty })),
    medications: meds.map((x) => ({ medicineCode: x.medicine_code, dose: x.dose, route: x.route })),
  };

  const contentHash = await sha256Hex(JSON.stringify(summary));
  const disclosureId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_patient_summary_disclosure (id, patient_id, disclosed_by, purpose, recipient, format, content_hash) VALUES (?,?,?,?,?,?,?)`,
      [disclosureId, args.patientId, args.disclosedBy ?? null, args.purpose, args.recipient ?? null, args.format ?? 'print', contentHash]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'export','patient_summary',?,?,'success',?,?)`,
      [uuidv7(), args.disclosedBy ?? null, disclosureId, args.patientId, `disclosed for: ${args.purpose}`, 'disclosure:' + disclosureId]),
  ]);
  return { summary, disclosureId, contentHash };
}

/** Disclosure history for a patient's summary exports (PAT-010). */
export async function listPatientDisclosures(db: D1Database, args: { patientId: string }): Promise<Array<{ id: string; purpose: string; recipient: string | null; format: string; disclosedAt: string }>> {
  return many(db, `SELECT id, purpose, recipient, format, disclosed_at AS disclosedAt FROM clinical_patient_summary_disclosure WHERE patient_id=? ORDER BY disclosed_at DESC`, [args.patientId]);
}
