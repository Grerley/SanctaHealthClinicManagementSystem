/**
 * Document upload + disclosure tracking on the edge (DOC-001/004/007). Uploads are
 * validated by the shared domain policy (type allow-list, size, content hash);
 * anything failing is stored QUARANTINED and cannot be opened. Opening a sensitive
 * document records a disclosure so every access is auditable (DOC-007).
 */
import type { Pool } from 'pg';
import { uuidv7, validateUpload, type UploadMeta } from '@sancta/domain';

export class DocumentError extends Error {}

export type UploadBody = UploadMeta & {
  patientId?: string;
  encounterId?: string;
  docType: string;
  securityLabel?: 'normal' | 'sensitive' | 'restricted';
  uploadedBy?: string;
};

export type UploadResult = { documentId: string; status: 'available' | 'quarantined'; reason?: string };

export async function uploadDocument(pool: Pool, body: UploadBody): Promise<UploadResult> {
  const validation = validateUpload({ filename: body.filename, mimeType: body.mimeType, sizeBytes: body.sizeBytes, sha256: body.sha256 });
  const documentId = uuidv7();
  const status = validation.ok ? 'available' : 'quarantined';
  const reason = validation.ok ? null : validation.reason;
  await pool.query(
    `INSERT INTO clinical.document_reference (id, patient_id, encounter_id, doc_type, filename, mime_type, size_bytes, sha256, security_label, status, quarantine_reason, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      documentId,
      body.patientId ?? null,
      body.encounterId ?? null,
      body.docType,
      body.filename,
      body.mimeType,
      body.sizeBytes,
      body.sha256,
      body.securityLabel ?? 'normal',
      status,
      reason,
      body.uploadedBy ?? null,
    ],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'create','document',$3,$4,$5,$6, now(), $7)`,
    [uuidv7(), body.uploadedBy ?? null, documentId, body.patientId ?? null, status === 'available' ? 'success' : 'quarantined', reason, 'doc:' + documentId],
  );
  return validation.ok ? { documentId, status } : { documentId, status, reason: validation.reason };
}

/**
 * Open a document. A quarantined document cannot be opened (DOC-004). Opening a
 * sensitive/restricted document records a disclosure and an audit event (DOC-007).
 */
export async function openDocument(pool: Pool, args: { documentId: string; userId: string; purpose?: string }): Promise<{ filename: string; mimeType: string; sha256: string; securityLabel: string }> {
  const r = await pool.query(`SELECT filename, mime_type, sha256, security_label, status FROM clinical.document_reference WHERE id=$1`, [args.documentId]);
  if (r.rows.length === 0) throw new DocumentError('document not found');
  if (r.rows[0].status === 'quarantined') throw new DocumentError('document is quarantined and cannot be opened');

  if (r.rows[0].security_label !== 'normal') {
    await pool.query(`INSERT INTO clinical.disclosure (id, document_id, user_id, purpose) VALUES ($1,$2,$3,$4)`, [uuidv7(), args.documentId, args.userId, args.purpose ?? null]);
    await pool.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'view','document',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.userId, args.documentId, 'sensitive disclosure: ' + (args.purpose ?? 'n/a'), 'disclose:' + uuidv7()],
    );
  }
  return { filename: r.rows[0].filename, mimeType: r.rows[0].mime_type, sha256: r.rows[0].sha256, securityLabel: r.rows[0].security_label };
}

export async function disclosureLog(pool: Pool, documentId: string): Promise<Array<{ userId: string; purpose: string | null; disclosedAt: string }>> {
  const r = await pool.query(
    `SELECT user_id, purpose, to_char(disclosed_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS disclosed_at FROM clinical.disclosure WHERE document_id=$1 ORDER BY disclosed_at`,
    [documentId],
  );
  return r.rows.map((x) => ({ userId: x.user_id, purpose: x.purpose, disclosedAt: x.disclosed_at }));
}
