/**
 * Document upload + disclosure tracking on D1 (DOC-001/004/006/007). Uploads are
 * validated by the shared domain policy (type allow-list, size, hash); anything
 * failing is stored QUARANTINED and cannot be opened. Opening a sensitive document
 * records a disclosure (auditable). Re-indexing is additive — a new version, never
 * overwriting the source. Ported from the Postgres edge `documents.ts`.
 *
 * D1 translations: interactive tx → db.batch(); text[] terms → a JSON array;
 * `= ANY(terms)` → json_each; DISTINCT ON → a ROW_NUMBER() window.
 */
import { uuidv7, validateUpload, type UploadMeta } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class DocumentError extends Error {}

export type UploadBody = UploadMeta & { patientId?: string; encounterId?: string; docType: string; securityLabel?: 'normal' | 'sensitive' | 'restricted'; uploadedBy?: string };
export type UploadResult = { documentId: string; status: 'available' | 'quarantined'; reason?: string };

export async function uploadDocument(db: D1Database, body: UploadBody): Promise<UploadResult> {
  const validation = validateUpload({ filename: body.filename, mimeType: body.mimeType, sizeBytes: body.sizeBytes, sha256: body.sha256 });
  const documentId = uuidv7();
  const status = validation.ok ? 'available' : 'quarantined';
  const reason = validation.ok ? null : validation.reason;
  await db.batch([
    stmt(db, `INSERT INTO clinical_document_reference (id, patient_id, encounter_id, doc_type, filename, mime_type, size_bytes, sha256, security_label, status, quarantine_reason, uploaded_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [documentId, body.patientId ?? null, body.encounterId ?? null, body.docType, body.filename, body.mimeType, body.sizeBytes, body.sha256, body.securityLabel ?? 'normal', status, reason, body.uploadedBy ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'create','document',?,?,?,?,?)`,
      [uuidv7(), body.uploadedBy ?? null, documentId, body.patientId ?? null, status === 'available' ? 'success' : 'quarantined', reason, 'doc:' + documentId]),
  ]);
  return validation.ok ? { documentId, status } : { documentId, status, reason: validation.reason };
}

/** Open a document. Quarantined cannot open (DOC-004); a sensitive/restricted open
 * records a disclosure + audit (DOC-007). */
export async function openDocument(db: D1Database, args: { documentId: string; userId: string; purpose?: string }): Promise<{ filename: string; mimeType: string; sha256: string; securityLabel: string }> {
  const r = await one<{ filename: string; mime_type: string; sha256: string; security_label: string; status: string }>(
    db, `SELECT filename, mime_type, sha256, security_label, status FROM clinical_document_reference WHERE id=?`, [args.documentId]);
  if (!r) throw new DocumentError('document not found');
  if (r.status === 'quarantined') throw new DocumentError('document is quarantined and cannot be opened');
  if (r.security_label !== 'normal') {
    await db.batch([
      stmt(db, `INSERT INTO clinical_disclosure (id, document_id, user_id, purpose) VALUES (?,?,?,?)`, [uuidv7(), args.documentId, args.userId, args.purpose ?? null]),
      stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'view','document',?,'success',?,?)`,
        [uuidv7(), args.userId, args.documentId, 'sensitive disclosure: ' + (args.purpose ?? 'n/a'), 'disclose:' + uuidv7()]),
    ]);
  }
  return { filename: r.filename, mimeType: r.mime_type, sha256: r.sha256, securityLabel: r.security_label };
}

export async function disclosureLog(db: D1Database, documentId: string): Promise<Array<{ userId: string; purpose: string | null; disclosedAt: string }>> {
  const rows = await many<{ user_id: string; purpose: string | null; disclosed_at: string }>(
    db, `SELECT user_id, purpose, disclosed_at FROM clinical_disclosure WHERE document_id=? ORDER BY disclosed_at`, [documentId]);
  return rows.map((x) => ({ userId: x.user_id, purpose: x.purpose, disclosedAt: x.disclosed_at }));
}

/** Attach index terms / OCR text (DOC-006). Additive: a re-index appends a version. */
export async function indexDocument(db: D1Database, args: { documentId: string; terms?: string[]; ocrText?: string; indexedBy?: string }): Promise<{ version: number }> {
  const doc = await one(db, `SELECT 1 AS ok FROM clinical_document_reference WHERE id=?`, [args.documentId]);
  if (!doc) throw new DocumentError('document not found');
  const cur = await one<{ v: number }>(db, `SELECT COALESCE(MAX(version),0) AS v FROM clinical_document_index WHERE document_id=?`, [args.documentId]);
  const version = Number(cur?.v ?? 0) + 1;
  await db.prepare(`INSERT INTO clinical_document_index (id, document_id, version, terms, ocr_text, indexed_by) VALUES (?,?,?,?,?,?)`)
    .bind(uuidv7(), args.documentId, version, JSON.stringify(args.terms ?? []), args.ocrText ?? null, args.indexedBy ?? null).run();
  return { version };
}

/** Find documents whose LATEST index carries a term (DOC-006). */
export async function searchDocuments(db: D1Database, term: string): Promise<Array<{ documentId: string; filename: string; version: number }>> {
  const rows = await many<{ document_id: string; filename: string; version: number }>(
    db,
    `SELECT document_id, filename, version FROM (
       SELECT di.document_id, dr.filename, di.version,
              ROW_NUMBER() OVER (PARTITION BY di.document_id ORDER BY di.version DESC) AS rn
       FROM clinical_document_index di JOIN clinical_document_reference dr ON dr.id = di.document_id
       WHERE EXISTS (SELECT 1 FROM json_each(di.terms) je WHERE je.value = ?)
     ) WHERE rn = 1`,
    [term],
  );
  return rows.map((x) => ({ documentId: x.document_id, filename: x.filename, version: Number(x.version) }));
}
