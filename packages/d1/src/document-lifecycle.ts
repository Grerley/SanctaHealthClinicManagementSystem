/**
 * Document generation snapshot, versioning & retention on D1 (DOC-002/003/005).
 * Store a generated document with an immutable snapshot + content hash; version/
 * supersede; mark entered-in-error; apply a legal hold; retention class + date
 * drive disposal, which is refused while held or before the retain-until date and
 * never hard-deletes. Ported from the Postgres edge `document-lifecycle.ts`.
 *
 * D1 translations: node:crypto → Web Crypto (barrel stays node-free); FOR UPDATE +
 * interactive tx → status-guarded writes inside db.batch().
 */
import { uuidv7, type ClinicalDocument } from '@sancta/domain';
import type { D1Database, D1PreparedStatement } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class DocLifecycleError extends Error {}

async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function auditStmt(db: D1Database, by: string | undefined, resourceId: string, action: string, reason: string): D1PreparedStatement {
  return stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,?,'document',?,'success',?,?)`,
    [uuidv7(), by ?? null, action, resourceId, reason, 'doc:' + resourceId + ':' + uuidv7()]);
}

/** Store a generated document with a retained snapshot + content hash (DOC-002). */
export async function storeGeneratedDocument(
  db: D1Database,
  args: { patientId?: string; encounterId?: string; document: ClinicalDocument; securityLabel?: string; retentionClass?: string; retainUntil?: string; generatedBy?: string },
): Promise<{ documentId: string; sha256: string }> {
  const json = JSON.stringify(args.document);
  const sha256 = await sha256Hex(json);
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_document_reference
       (id, patient_id, encounter_id, doc_type, filename, mime_type, size_bytes, sha256, security_label, status, snapshot, retention_class, retain_until, uploaded_by)
       VALUES (?,?,?,?,?,'application/json',?,?,?,'available',?,?,?,?)`,
      [id, args.patientId ?? null, args.encounterId ?? null, args.document.type, `${args.document.type}-${id.slice(-8)}.json`,
       new TextEncoder().encode(json).length, sha256, args.securityLabel ?? 'normal', json, args.retentionClass ?? null, args.retainUntil ?? null, args.generatedBy ?? null]),
    auditStmt(db, args.generatedBy, id, 'create', `generated ${args.document.type}`),
  ]);
  return { documentId: id, sha256 };
}

/** Supersede a document with a newer version (DOC-003). Old → superseded. */
export async function supersedeDocument(db: D1Database, args: { documentId: string; newDocumentId: string; by: string }): Promise<{ documentId: string; version: number }> {
  const old = await one<{ version: number; status: string }>(db, `SELECT version, status FROM clinical_document_reference WHERE id=?`, [args.documentId]);
  if (!old) throw new DocLifecycleError('document not found');
  if (old.status !== 'available') throw new DocLifecycleError(`a ${old.status} document cannot be superseded`);
  const nextVersion = Number(old.version) + 1;
  await db.batch([
    stmt(db, `UPDATE clinical_document_reference SET status='superseded' WHERE id=? AND status='available'`, [args.documentId]),
    stmt(db, `UPDATE clinical_document_reference SET version=?, supersedes=? WHERE id=?`, [nextVersion, args.documentId, args.newDocumentId]),
    auditStmt(db, args.by, args.documentId, 'amend', `superseded by ${args.newDocumentId} (v${nextVersion})`),
  ]);
  return { documentId: args.newDocumentId, version: nextVersion };
}

/** Mark a document entered-in-error (DOC-003). Retained, never deleted. */
export async function markDocumentEnteredInError(db: D1Database, args: { documentId: string; reason: string; by: string }): Promise<{ status: 'entered_in_error' }> {
  if (!args.reason?.trim()) throw new DocLifecycleError('a reason is required');
  const changed = await run(db, `UPDATE clinical_document_reference SET status='entered_in_error' WHERE id=? AND status <> 'disposed'`, [args.documentId]);
  if (changed === 0) throw new DocLifecycleError('document not found or disposed');
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','document',?,'success',?,?)`)
    .bind(uuidv7(), args.by, args.documentId, 'entered_in_error: ' + args.reason, 'doc:' + args.documentId + ':' + uuidv7()).run();
  return { status: 'entered_in_error' };
}

/** Apply or lift a legal hold (DOC-003/005). A held document cannot be disposed. */
export async function setLegalHold(db: D1Database, args: { documentId: string; hold: boolean; by: string }): Promise<{ documentId: string; legalHold: boolean }> {
  const changed = await run(db, `UPDATE clinical_document_reference SET legal_hold=? WHERE id=?`, [args.hold ? 1 : 0, args.documentId]);
  if (changed === 0) throw new DocLifecycleError('document not found');
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','document',?,'success',?,?)`)
    .bind(uuidv7(), args.by, args.documentId, `legal hold ${args.hold ? 'applied' : 'lifted'}`, 'doc:' + args.documentId + ':' + uuidv7()).run();
  return { documentId: args.documentId, legalHold: args.hold };
}

/** Set retention class + retain-until date (DOC-005). */
export async function setRetention(db: D1Database, args: { documentId: string; retentionClass: string; retainUntil: string; by: string }): Promise<{ documentId: string }> {
  const changed = await run(db, `UPDATE clinical_document_reference SET retention_class=?, retain_until=? WHERE id=?`, [args.retentionClass, args.retainUntil, args.documentId]);
  if (changed === 0) throw new DocLifecycleError('document not found');
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','document',?,'success',?,?)`)
    .bind(uuidv7(), args.by, args.documentId, `retention ${args.retentionClass} until ${args.retainUntil}`, 'doc:' + args.documentId + ':' + uuidv7()).run();
  return { documentId: args.documentId };
}

/** Documents eligible for disposal as-of a date (past retention, not held) (DOC-005). */
export async function disposalCandidates(db: D1Database, asOf: string): Promise<Array<{ id: string; docType: string; retentionClass: string | null; retainUntil: string }>> {
  const rows = await many<{ id: string; doc_type: string; retention_class: string | null; ru: string }>(
    db, `SELECT id, doc_type, retention_class, retain_until AS ru FROM clinical_document_reference
         WHERE status <> 'disposed' AND legal_hold=0 AND retain_until IS NOT NULL AND retain_until < ? ORDER BY retain_until`, [asOf]);
  return rows.map((x) => ({ id: x.id, docType: x.doc_type, retentionClass: x.retention_class, retainUntil: x.ru }));
}

/** Dispose a document (DOC-005). Refused while held or before retain-until. Audited. */
export async function disposeDocument(db: D1Database, args: { documentId: string; asOf: string; by: string }): Promise<{ status: 'disposed' }> {
  const d = await one<{ legal_hold: number; ru: string | null; status: string }>(db, `SELECT legal_hold, retain_until AS ru, status FROM clinical_document_reference WHERE id=?`, [args.documentId]);
  if (!d) throw new DocLifecycleError('document not found');
  if (d.status === 'disposed') throw new DocLifecycleError('document already disposed');
  if (d.legal_hold) throw new DocLifecycleError('document is on legal hold and cannot be disposed');
  if (!d.ru || args.asOf < d.ru) throw new DocLifecycleError('document is within its retention period');
  await db.batch([
    stmt(db, `UPDATE clinical_document_reference SET status='disposed', disposed_at=${NOW}, snapshot=NULL WHERE id=? AND status <> 'disposed'`, [args.documentId]),
    auditStmt(db, args.by, args.documentId, 'config', 'disposed per retention policy'),
  ]);
  return { status: 'disposed' };
}
