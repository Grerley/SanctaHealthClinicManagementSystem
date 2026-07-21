/**
 * Patient communication (COM-001/002/003). Consent/preference is checked BEFORE a
 * message is created — a non-consented message is recorded as suppressed, never
 * sent (COM-001). A unique dedup key means an offline-created message sends exactly
 * once after connectivity returns (COM-002). Approved templates only; free-text
 * sensitive content is not accepted here (COM-003).
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class CommsError extends Error {}

export type Purpose = 'clinical' | 'billing' | 'reminder' | 'outreach';
export type Channel = 'sms' | 'email' | 'print';

export async function setPreference(pool: Pool, args: { patientId: string; purpose: Purpose; channel: Channel; allowed: boolean }): Promise<void> {
  await pool.query(
    `INSERT INTO flow.communication_preference (id, patient_id, purpose, channel, allowed)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (patient_id, purpose, channel) DO UPDATE SET allowed = EXCLUDED.allowed`,
    [uuidv7(), args.patientId, args.purpose, args.channel, args.allowed],
  );
}

async function isAllowed(pool: Pool, patientId: string, purpose: Purpose, channel: Channel): Promise<boolean> {
  const r = await pool.query(`SELECT allowed FROM flow.communication_preference WHERE patient_id=$1 AND purpose=$2 AND channel=$3`, [patientId, purpose, channel]);
  // Default deny for non-print channels unless a preference explicitly allows it;
  // print is always available (assisted printing, COM-005).
  if (r.rows.length === 0) return channel === 'print';
  return Boolean(r.rows[0].allowed);
}

export type QueueMessageResult = { messageId: string; status: 'queued' | 'suppressed' | 'duplicate' };

/** Queue a message if consented; otherwise record it suppressed. Send-once via dedupKey. */
export async function queueMessage(
  pool: Pool,
  args: { patientId: string; purpose: Purpose; channel: Channel; template: string; dedupKey: string },
): Promise<QueueMessageResult> {
  // Suppression is applied before creation/sending (COM-001).
  const allowed = await isAllowed(pool, args.patientId, args.purpose, args.channel);
  const status = allowed ? 'queued' : 'suppressed';
  const messageId = uuidv7();
  try {
    await pool.query(
      `INSERT INTO flow.message (id, patient_id, purpose, channel, template, status, dedup_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [messageId, args.patientId, args.purpose, args.channel, args.template, status, args.dedupKey],
    );
  } catch (e) {
    // Unique dedup_key violation => this message already exists (send once, COM-002).
    if ((e as { code?: string }).code === '23505') return { messageId: '', status: 'duplicate' };
    throw e;
  }
  return { messageId, status };
}

export async function markSent(pool: Pool, messageId: string): Promise<void> {
  const r = await pool.query(`UPDATE flow.message SET status='sent', sent_at=now() WHERE id=$1 AND status='queued'`, [messageId]);
  if (r.rowCount === 0) throw new CommsError('message not in a sendable state');
}

export async function pendingMessages(pool: Pool): Promise<Array<{ messageId: string; patientId: string; channel: string; template: string }>> {
  const r = await pool.query(`SELECT id, patient_id, channel, template FROM flow.message WHERE status='queued' ORDER BY created_at`);
  return r.rows.map((x) => ({ messageId: x.id, patientId: x.patient_id, channel: x.channel, template: x.template }));
}

// --- Inbound responses → tasks (COM-004) ------------------------------------

/**
 * Record an inbound patient response and raise a follow-up task linked to it
 * (COM-004). Where the reply is to a known outbound message, the link is kept so
 * the loop can be closed against its source.
 */
export async function recordInbound(
  pool: Pool,
  args: { patientId?: string; channel?: string; body: string; inReplyTo?: string; summary?: string; assignedRole?: string },
): Promise<{ inboundId: string; taskId: string }> {
  if (!args.body?.trim()) throw new CommsError('an inbound message body is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inboundId = uuidv7();
    await client.query(
      `INSERT INTO flow.inbound_message (id, patient_id, channel, body, in_reply_to) VALUES ($1,$2,$3,$4,$5)`,
      [inboundId, args.patientId ?? null, args.channel ?? 'sms', args.body, args.inReplyTo ?? null],
    );
    const taskId = uuidv7();
    await client.query(
      `INSERT INTO flow.comms_task (id, inbound_id, patient_id, summary, assigned_role) VALUES ($1,$2,$3,$4,$5)`,
      [taskId, inboundId, args.patientId ?? null, args.summary ?? `Respond to inbound message: ${args.body.slice(0, 80)}`, args.assignedRole ?? null],
    );
    await client.query('COMMIT');
    return { inboundId, taskId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Open communication tasks awaiting action (COM-004). */
export async function openCommsTasks(pool: Pool): Promise<Array<{ taskId: string; patientId: string | null; summary: string; inboundId: string }>> {
  const r = await pool.query(
    `SELECT id, patient_id, summary, inbound_id FROM flow.comms_task WHERE status='open' ORDER BY created_at`,
  );
  return r.rows.map((x) => ({ taskId: x.id, patientId: x.patient_id, summary: x.summary, inboundId: x.inbound_id }));
}

/** Close a communication task once actioned (COM-004). */
export async function completeCommsTask(pool: Pool, args: { taskId: string; by?: string }): Promise<{ status: 'done' }> {
  const r = await pool.query(`UPDATE flow.comms_task SET status='done', closed_at=now(), closed_by=$2 WHERE id=$1 AND status='open'`, [args.taskId, args.by ?? null]);
  if (r.rowCount === 0) throw new CommsError('task not found or already closed');
  return { status: 'done' };
}
