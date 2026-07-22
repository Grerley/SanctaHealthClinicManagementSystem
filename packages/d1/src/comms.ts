/**
 * Patient communication on D1 (COM-001..005). Consent/preference is checked BEFORE
 * a message is created — a non-consented message is recorded suppressed, never sent
 * (COM-001). A UNIQUE dedup key sends an offline-created message exactly once
 * (COM-002). Approved templates only (COM-003). Inbound replies raise a follow-up
 * task (COM-004). Ported from the Postgres edge `comms.ts`.
 *
 * D1 translations: upsert via ON CONFLICT; the Postgres unique-violation code
 * (23505) → catching the SQLite UNIQUE error to return 'duplicate'.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

export class CommsError extends Error {}

export type Purpose = 'clinical' | 'billing' | 'reminder' | 'outreach';
export type Channel = 'sms' | 'email' | 'print';

export async function setPreference(db: D1Database, args: { patientId: string; purpose: Purpose; channel: Channel; allowed: boolean }): Promise<void> {
  await db.prepare(`INSERT INTO flow_communication_preference (id, patient_id, purpose, channel, allowed) VALUES (?,?,?,?,?)
    ON CONFLICT(patient_id, purpose, channel) DO UPDATE SET allowed = excluded.allowed`)
    .bind(uuidv7(), args.patientId, args.purpose, args.channel, args.allowed ? 1 : 0).run();
}

async function isAllowed(db: D1Database, patientId: string, purpose: Purpose, channel: Channel): Promise<boolean> {
  const r = await one<{ allowed: number }>(db, `SELECT allowed FROM flow_communication_preference WHERE patient_id=? AND purpose=? AND channel=?`, [patientId, purpose, channel]);
  // Default deny for non-print channels unless explicitly allowed; print is always available (COM-005).
  if (!r) return channel === 'print';
  return Boolean(r.allowed);
}

export type QueueMessageResult = { messageId: string; status: 'queued' | 'suppressed' | 'duplicate' };

/** Queue a message if consented; else record suppressed. Send-once via dedupKey. */
export async function queueMessage(db: D1Database, args: { patientId: string; purpose: Purpose; channel: Channel; template: string; dedupKey: string }): Promise<QueueMessageResult> {
  const status = (await isAllowed(db, args.patientId, args.purpose, args.channel)) ? 'queued' : 'suppressed';
  const messageId = uuidv7();
  try {
    await db.prepare(`INSERT INTO flow_message (id, patient_id, purpose, channel, template, status, dedup_key) VALUES (?,?,?,?,?,?,?)`)
      .bind(messageId, args.patientId, args.purpose, args.channel, args.template, status, args.dedupKey).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) return { messageId: '', status: 'duplicate' };
    throw e;
  }
  return { messageId, status };
}

export async function markSent(db: D1Database, messageId: string): Promise<void> {
  const changed = await run(db, `UPDATE flow_message SET status='sent', sent_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='queued'`, [messageId]);
  if (changed === 0) throw new CommsError('message not in a sendable state');
}

export async function pendingMessages(db: D1Database): Promise<Array<{ messageId: string; patientId: string; channel: string; template: string }>> {
  const rows = await many<{ id: string; patient_id: string; channel: string; template: string }>(db, `SELECT id, patient_id, channel, template FROM flow_message WHERE status='queued' ORDER BY created_at`);
  return rows.map((x) => ({ messageId: x.id, patientId: x.patient_id, channel: x.channel, template: x.template }));
}

// --- Inbound responses → tasks (COM-004) ------------------------------------

/** Record an inbound patient response and raise a linked follow-up task (COM-004). */
export async function recordInbound(db: D1Database, args: { patientId?: string; channel?: string; body: string; inReplyTo?: string; summary?: string; assignedRole?: string }): Promise<{ inboundId: string; taskId: string }> {
  if (!args.body?.trim()) throw new CommsError('an inbound message body is required');
  const inboundId = uuidv7();
  const taskId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO flow_inbound_message (id, patient_id, channel, body, in_reply_to) VALUES (?,?,?,?,?)`, [inboundId, args.patientId ?? null, args.channel ?? 'sms', args.body, args.inReplyTo ?? null]),
    stmt(db, `INSERT INTO flow_comms_task (id, inbound_id, patient_id, summary, assigned_role) VALUES (?,?,?,?,?)`,
      [taskId, inboundId, args.patientId ?? null, args.summary ?? `Respond to inbound message: ${args.body.slice(0, 80)}`, args.assignedRole ?? null]),
  ]);
  return { inboundId, taskId };
}

export async function openCommsTasks(db: D1Database): Promise<Array<{ taskId: string; patientId: string | null; summary: string; inboundId: string }>> {
  const rows = await many<{ id: string; patient_id: string | null; summary: string; inbound_id: string }>(db, `SELECT id, patient_id, summary, inbound_id FROM flow_comms_task WHERE status='open' ORDER BY created_at`);
  return rows.map((x) => ({ taskId: x.id, patientId: x.patient_id, summary: x.summary, inboundId: x.inbound_id }));
}

export async function completeCommsTask(db: D1Database, args: { taskId: string; by?: string }): Promise<{ status: 'done' }> {
  const changed = await run(db, `UPDATE flow_comms_task SET status='done', closed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), closed_by=? WHERE id=? AND status='open'`, [args.by ?? null, args.taskId]);
  if (changed === 0) throw new CommsError('task not found or already closed');
  return { status: 'done' };
}
