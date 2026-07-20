/**
 * Document generation snapshot, versioning & retention (DOC-002/003/005, pack §8.4).
 *
 * DOC-002: store a generated document with an immutable content snapshot + hash.
 * DOC-003: version/supersede documents; mark entered-in-error; apply a legal hold.
 * DOC-005: retention class + date drive disposal; disposal is audited and refused
 * while on legal hold or before the retention date. Nothing is ever hard-deleted.
 */
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { uuidv7, type ClinicalDocument } from '@sancta/domain';

export class DocLifecycleError extends Error {}

async function audit(pool: Pool, by: string | undefined, resourceId: string, action: string, reason: string): Promise<void> {
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,$3,'document',$4,'success',$5, now(), $6)`,
    [uuidv7(), by ?? null, action, resourceId, reason, 'doc:' + resourceId + ':' + uuidv7()],
  );
}

/**
 * Store a generated templated document with a retained snapshot + content hash
 * (DOC-002). The snapshot is immutable evidence of what was produced.
 */
export async function storeGeneratedDocument(
  pool: Pool,
  args: { patientId?: string; encounterId?: string; document: ClinicalDocument; securityLabel?: string; retentionClass?: string; retainUntil?: string; generatedBy?: string },
): Promise<{ documentId: string; sha256: string }> {
  const json = JSON.stringify(args.document);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO clinical.document_reference
       (id, patient_id, encounter_id, doc_type, filename, mime_type, size_bytes, sha256, security_label, status, snapshot, retention_class, retain_until, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,'application/json',$6,$7,$8,'available',$9,$10,$11,$12)`,
    [id, args.patientId ?? null, args.encounterId ?? null, args.document.type, `${args.document.type}-${id.slice(-8)}.json`, Buffer.byteLength(json), sha256, args.securityLabel ?? 'normal', json, args.retentionClass ?? null, args.retainUntil ?? null, args.generatedBy ?? null],
  );
  await audit(pool, args.generatedBy, id, 'create', `generated ${args.document.type}`);
  return { documentId: id, sha256 };
}

/** Supersede a document with a newer version (DOC-003). Old → superseded. */
export async function supersedeDocument(pool: Pool, args: { documentId: string; newDocumentId: string; by: string }): Promise<{ documentId: string; version: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query(`SELECT version, status FROM clinical.document_reference WHERE id=$1 FOR UPDATE`, [args.documentId]);
    if (old.rowCount === 0) throw new DocLifecycleError('document not found');
    if (old.rows[0].status !== 'available') throw new DocLifecycleError(`a ${old.rows[0].status} document cannot be superseded`);
    const nextVersion = (old.rows[0].version as number) + 1;
    await client.query(`UPDATE clinical.document_reference SET status='superseded' WHERE id=$1`, [args.documentId]);
    await client.query(`UPDATE clinical.document_reference SET version=$2, supersedes=$3 WHERE id=$1`, [args.newDocumentId, nextVersion, args.documentId]);
    await client.query('COMMIT');
    await audit(pool, args.by, args.documentId, 'amend', `superseded by ${args.newDocumentId} (v${nextVersion})`);
    return { documentId: args.newDocumentId, version: nextVersion };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Mark a document entered-in-error (DOC-003). Retained, never deleted. */
export async function markDocumentEnteredInError(pool: Pool, args: { documentId: string; reason: string; by: string }): Promise<{ status: 'entered_in_error' }> {
  if (!args.reason?.trim()) throw new DocLifecycleError('a reason is required');
  const r = await pool.query(`UPDATE clinical.document_reference SET status='entered_in_error' WHERE id=$1 AND status <> 'disposed' RETURNING id`, [args.documentId]);
  if (r.rowCount === 0) throw new DocLifecycleError('document not found or disposed');
  await audit(pool, args.by, args.documentId, 'amend', 'entered_in_error: ' + args.reason);
  return { status: 'entered_in_error' };
}

/** Apply or lift a legal hold (DOC-003/005). A held document cannot be disposed. */
export async function setLegalHold(pool: Pool, args: { documentId: string; hold: boolean; by: string }): Promise<{ documentId: string; legalHold: boolean }> {
  const r = await pool.query(`UPDATE clinical.document_reference SET legal_hold=$2 WHERE id=$1 RETURNING id`, [args.documentId, args.hold]);
  if (r.rowCount === 0) throw new DocLifecycleError('document not found');
  await audit(pool, args.by, args.documentId, 'config', `legal hold ${args.hold ? 'applied' : 'lifted'}`);
  return { documentId: args.documentId, legalHold: args.hold };
}

/** Set retention class + retain-until date (DOC-005). */
export async function setRetention(pool: Pool, args: { documentId: string; retentionClass: string; retainUntil: string; by: string }): Promise<{ documentId: string }> {
  const r = await pool.query(`UPDATE clinical.document_reference SET retention_class=$2, retain_until=$3 WHERE id=$1 RETURNING id`, [args.documentId, args.retentionClass, args.retainUntil]);
  if (r.rowCount === 0) throw new DocLifecycleError('document not found');
  await audit(pool, args.by, args.documentId, 'config', `retention ${args.retentionClass} until ${args.retainUntil}`);
  return { documentId: args.documentId };
}

/** Documents eligible for disposal as-of a date (past retention, not held) (DOC-005). */
export async function disposalCandidates(pool: Pool, asOf: string): Promise<Array<{ id: string; docType: string; retentionClass: string | null; retainUntil: string }>> {
  const r = await pool.query(
    `SELECT id, doc_type, retention_class, to_char(retain_until,'YYYY-MM-DD') AS ru FROM clinical.document_reference
     WHERE status <> 'disposed' AND legal_hold=false AND retain_until IS NOT NULL AND retain_until < $1
     ORDER BY retain_until`,
    [asOf],
  );
  return r.rows.map((x) => ({ id: x.id, docType: x.doc_type, retentionClass: x.retention_class, retainUntil: x.ru }));
}

/** Dispose a document (DOC-005). Refused while on legal hold or before retain-until. Audited. */
export async function disposeDocument(pool: Pool, args: { documentId: string; asOf: string; by: string }): Promise<{ status: 'disposed' }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT legal_hold, to_char(retain_until,'YYYY-MM-DD') AS ru, status FROM clinical.document_reference WHERE id=$1 FOR UPDATE`, [args.documentId]);
    if (r.rowCount === 0) throw new DocLifecycleError('document not found');
    const d = r.rows[0];
    if (d.status === 'disposed') throw new DocLifecycleError('document already disposed');
    if (d.legal_hold === true) throw new DocLifecycleError('document is on legal hold and cannot be disposed');
    if (!d.ru || args.asOf < d.ru) throw new DocLifecycleError('document is within its retention period');
    // Snapshot content is cleared on disposal; the metadata + hash are retained for audit.
    await client.query(`UPDATE clinical.document_reference SET status='disposed', disposed_at=now(), snapshot=NULL WHERE id=$1`, [args.documentId]);
    await client.query('COMMIT');
    await audit(pool, args.by, args.documentId, 'config', 'disposed per retention policy');
    return { status: 'disposed' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
