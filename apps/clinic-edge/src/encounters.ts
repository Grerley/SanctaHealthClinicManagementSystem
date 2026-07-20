/**
 * Clinical encounter signing, addendum and entered-in-error (EHR-008/009, BR-003,
 * UAT-04). A signed encounter is immutable: it can only receive a linked addendum
 * or be marked entered-in-error — never edited back to draft or overwritten. The
 * original content stays visible to authorised reviewers. Transitions are guarded
 * by the shared encounter state machine.
 */
import type { Pool } from 'pg';
import { uuidv7, assertTransition, ENCOUNTER_TRANSITIONS, isSignedImmutable, type EncounterState } from '@sancta/domain';

const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';

export class EncounterError extends Error {}

export async function createDraftEncounter(pool: Pool, args: { patientId: string; user?: string }): Promise<{ encounterId: string; visitId: string }> {
  const visitId = uuidv7();
  const encounterId = uuidv7();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status) VALUES ($1,$2,$3,$4,'in_care')`, [
      visitId,
      args.patientId,
      'V-' + visitId.slice(-12),
      DEFAULT_SITE,
    ]);
    await client.query(`INSERT INTO clinical.encounter (id, visit_id, patient_id, status, form_version, content) VALUES ($1,$2,$3,'draft',1,'{}')`, [
      encounterId,
      visitId,
      args.patientId,
    ]);
    await client.query('COMMIT');
    return { encounterId, visitId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function currentStatus(pool: Pool, encounterId: string): Promise<EncounterState> {
  const r = await pool.query(`SELECT status FROM clinical.encounter WHERE id=$1`, [encounterId]);
  if (r.rows.length === 0) throw new EncounterError('encounter not found');
  return r.rows[0].status as EncounterState;
}

/** Edit draft content. Rejected once the encounter is signed (BR-003). */
export async function updateDraft(pool: Pool, args: { encounterId: string; content: unknown }): Promise<void> {
  const status = await currentStatus(pool, args.encounterId);
  if (isSignedImmutable(status)) throw new EncounterError('signed content is immutable; use an addendum');
  await pool.query(`UPDATE clinical.encounter SET content=$2 WHERE id=$1`, [args.encounterId, JSON.stringify(args.content)]);
}

/** Sign the encounter (draft/ready -> signed). Signed content becomes immutable. */
export async function signEncounter(pool: Pool, args: { encounterId: string; signedBy: string; content?: unknown }): Promise<{ status: 'signed' }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT status, content FROM clinical.encounter WHERE id=$1 FOR UPDATE`, [args.encounterId]);
    if (r.rows.length === 0) throw new EncounterError('encounter not found');
    let from = r.rows[0].status as EncounterState;
    if (from === 'draft') {
      assertTransition(ENCOUNTER_TRANSITIONS, from, 'ready_to_sign');
      from = 'ready_to_sign';
    }
    assertTransition(ENCOUNTER_TRANSITIONS, from, 'signed'); // throws if already signed/entered-in-error
    const content = args.content === undefined ? r.rows[0].content : JSON.stringify(args.content);
    await client.query(`UPDATE clinical.encounter SET status='signed', signed_by=$2, signed_at=now(), content=$3 WHERE id=$1`, [
      args.encounterId,
      args.signedBy,
      content,
    ]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, captured_at, event_hash)
       VALUES ($1,$2,'sign','encounter',$3,'success', now(), $4)`,
      [uuidv7(), args.signedBy, args.encounterId, 'sign-enc:' + args.encounterId],
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

/** Add a linked addendum to a signed encounter (EHR-009). Original is untouched. */
export async function addAddendum(pool: Pool, args: { encounterId: string; author: string; content: unknown }): Promise<{ addendumId: string }> {
  const status = await currentStatus(pool, args.encounterId);
  if (status !== 'signed') throw new EncounterError('addenda apply only to signed encounters');
  const addendumId = uuidv7();
  await pool.query(`INSERT INTO clinical.encounter_addendum (id, encounter_id, author, content) VALUES ($1,$2,$3,$4)`, [
    addendumId,
    args.encounterId,
    args.author,
    JSON.stringify(args.content),
  ]);
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, captured_at, event_hash)
     VALUES ($1,$2,'amend','encounter',$3,'success', now(), $4)`,
    [uuidv7(), args.author, args.encounterId, 'addendum:' + addendumId],
  );
  return { addendumId };
}

/** Mark a signed encounter entered-in-error. Original content remains visible. */
export async function markEnteredInError(pool: Pool, args: { encounterId: string; user: string; reason: string }): Promise<{ status: 'entered_in_error' }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const from = (await client.query(`SELECT status FROM clinical.encounter WHERE id=$1 FOR UPDATE`, [args.encounterId])).rows[0]?.status as EncounterState;
    if (from === undefined) throw new EncounterError('encounter not found');
    assertTransition(ENCOUNTER_TRANSITIONS, from, 'entered_in_error');
    await client.query(`UPDATE clinical.encounter SET status='entered_in_error' WHERE id=$1`, [args.encounterId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','encounter',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.user, args.encounterId, args.reason, 'eie:' + args.encounterId],
    );
    await client.query('COMMIT');
    return { status: 'entered_in_error' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getEncounter(pool: Pool, encounterId: string): Promise<{ status: string; content: unknown; signedBy: string | null; addenda: Array<{ author: string; content: unknown; createdAt: string }> }> {
  const e = await pool.query(`SELECT status, content, signed_by FROM clinical.encounter WHERE id=$1`, [encounterId]);
  if (e.rows.length === 0) throw new EncounterError('encounter not found');
  const a = await pool.query(
    `SELECT author, content, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at FROM clinical.encounter_addendum WHERE encounter_id=$1 ORDER BY created_at`,
    [encounterId],
  );
  return {
    status: e.rows[0].status,
    content: e.rows[0].content,
    signedBy: e.rows[0].signed_by,
    addenda: a.rows.map((r) => ({ author: r.author, content: r.content, createdAt: r.created_at })),
  };
}
