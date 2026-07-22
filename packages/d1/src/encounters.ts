/**
 * Clinical encounter signing, addendum and entered-in-error on D1 (EHR-008/009,
 * BR-003, UAT-04). A signed encounter is immutable — it can only receive a linked
 * addendum or be marked entered-in-error, never edited back to draft. Ported from
 * the Postgres edge `encounters.ts`.
 *
 * Note: form-validated signing (EHR-003, `attachForm` + assertFormContent against
 * a form_definition version) lands with the forms module. Until then form_code
 * stays NULL and signing does not run form validation — the core immutability and
 * state-machine guarantees below are unchanged.
 *
 * D1 translations: FOR UPDATE + BEGIN/COMMIT → db.batch() with the state read
 * first, then a status-guarded UPDATE so a concurrent signer cannot double-apply.
 */
import { uuidv7, assertTransition, ENCOUNTER_TRANSITIONS, isSignedImmutable, type EncounterState } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class EncounterError extends Error {}

async function currentStatus(db: D1Database, encounterId: string): Promise<EncounterState> {
  const r = await one<{ status: string }>(db, `SELECT status FROM clinical_encounter WHERE id=?`, [encounterId]);
  if (!r) throw new EncounterError('encounter not found');
  return r.status as EncounterState;
}

/** Open a draft encounter (and its visit). */
export async function createDraftEncounter(db: D1Database, args: { patientId: string; user?: string }): Promise<{ encounterId: string; visitId: string }> {
  const visitId = uuidv7();
  const encounterId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO flow_visit (id, patient_id, visit_number, status) VALUES (?,?,?,'in_care')`, [visitId, args.patientId, 'V-' + visitId.slice(-12)]),
    stmt(db, `INSERT INTO clinical_encounter (id, visit_id, patient_id, status, form_version, content) VALUES (?,?,?,'draft',1,'{}')`, [encounterId, visitId, args.patientId]),
  ]);
  return { encounterId, visitId };
}

/** Edit draft content. Rejected once the encounter is signed (BR-003). */
export async function updateDraft(db: D1Database, args: { encounterId: string; content: unknown }): Promise<void> {
  const status = await currentStatus(db, args.encounterId);
  if (isSignedImmutable(status)) throw new EncounterError('signed content is immutable; use an addendum');
  await db.prepare(`UPDATE clinical_encounter SET content=? WHERE id=?`).bind(JSON.stringify(args.content), args.encounterId).run();
}

/** Sign the encounter (draft/ready -> signed). Signed content becomes immutable. */
export async function signEncounter(db: D1Database, args: { encounterId: string; signedBy: string; content?: unknown }): Promise<{ status: 'signed' }> {
  const r = await one<{ status: string; content: string }>(db, `SELECT status, content FROM clinical_encounter WHERE id=?`, [args.encounterId]);
  if (!r) throw new EncounterError('encounter not found');
  let from = r.status as EncounterState;
  if (from === 'draft') {
    assertTransition(ENCOUNTER_TRANSITIONS, from, 'ready_to_sign');
    from = 'ready_to_sign';
  }
  assertTransition(ENCOUNTER_TRANSITIONS, from, 'signed'); // throws if already signed / entered-in-error
  const content = args.content === undefined ? r.content : JSON.stringify(args.content);
  await db.batch([
    // Guard on a not-yet-signed status so a concurrent sign cannot double-apply.
    stmt(db, `UPDATE clinical_encounter SET status='signed', signed_by=?, signed_at=${NOW}, content=? WHERE id=? AND status IN ('draft','ready_to_sign')`,
      [args.signedBy, content, args.encounterId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, event_hash)
              VALUES (?,?,'sign','encounter',?,'success',?)`, [uuidv7(), args.signedBy, args.encounterId, 'sign-enc:' + args.encounterId]),
  ]);
  return { status: 'signed' };
}

/** Add a linked addendum to a signed encounter (EHR-009). Original untouched. */
export async function addAddendum(db: D1Database, args: { encounterId: string; author: string; content: unknown }): Promise<{ addendumId: string }> {
  const status = await currentStatus(db, args.encounterId);
  if (status !== 'signed') throw new EncounterError('addenda apply only to signed encounters');
  const addendumId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_encounter_addendum (id, encounter_id, author, content) VALUES (?,?,?,?)`, [addendumId, args.encounterId, args.author, JSON.stringify(args.content)]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, event_hash)
              VALUES (?,?,'amend','encounter',?,'success',?)`, [uuidv7(), args.author, args.encounterId, 'addendum:' + addendumId]),
  ]);
  return { addendumId };
}

/** Mark a signed encounter entered-in-error. Original content remains visible. */
export async function markEnteredInError(db: D1Database, args: { encounterId: string; user: string; reason: string }): Promise<{ status: 'entered_in_error' }> {
  const from = await currentStatus(db, args.encounterId);
  assertTransition(ENCOUNTER_TRANSITIONS, from, 'entered_in_error');
  await db.batch([
    stmt(db, `UPDATE clinical_encounter SET status='entered_in_error' WHERE id=? AND status=?`, [args.encounterId, from]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash)
              VALUES (?,?,'amend','encounter',?,'success',?,?)`, [uuidv7(), args.user, args.encounterId, args.reason, 'eie:' + args.encounterId]),
  ]);
  return { status: 'entered_in_error' };
}

export async function getEncounter(db: D1Database, encounterId: string): Promise<{ status: string; content: unknown; signedBy: string | null; addenda: Array<{ author: string; content: unknown; createdAt: string }> }> {
  const e = await one<{ status: string; content: string; signed_by: string | null }>(db, `SELECT status, content, signed_by FROM clinical_encounter WHERE id=?`, [encounterId]);
  if (!e) throw new EncounterError('encounter not found');
  const a = await many<{ author: string; content: string; created_at: string }>(
    db, `SELECT author, content, created_at FROM clinical_encounter_addendum WHERE encounter_id=? ORDER BY created_at`, [encounterId]);
  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };
  return {
    status: e.status,
    content: parse(e.content),
    signedBy: e.signed_by,
    addenda: a.map((r) => ({ author: r.author, content: parse(r.content), createdAt: r.created_at })),
  };
}
