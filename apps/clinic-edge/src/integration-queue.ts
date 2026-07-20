/**
 * Online-integration queue (SYN-010, CLD-003, pack §15.2).
 *
 * Outbound integrations are enqueued as part of the local business transaction
 * (a plain INSERT that commits with the clinical/financial write). Delivery is
 * separate and out-of-band: a failing integration NEVER blocks or rolls back the
 * local transaction. Delivery has bounded retry; after max attempts an item moves
 * to a dead-letter state (DLQ) for an audited replay. Idempotency keys make every
 * attempt and replay safe — a key already delivered is never delivered twice.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class IntegrationError extends Error {}

/** Deliver an item to the external system. Throwing signals a retryable failure. */
export type Deliver = (item: { id: string; kind: string; payload: unknown; idempotencyKey: string }) => Promise<void>;

/**
 * Enqueue an outbound integration within the caller's transaction. Just an INSERT
 * — it commits atomically with the business change and cannot fail for network
 * reasons, so the local transaction is never at the mercy of an integration.
 */
export async function enqueueIntegration(
  client: PoolClient,
  args: { kind: string; payload: unknown; idempotencyKey: string; maxAttempts?: number },
): Promise<{ id: string }> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO security_sync.integration_queue (id, kind, idempotency_key, payload, max_attempts)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, args.kind, args.idempotencyKey, JSON.stringify(args.payload), args.maxAttempts ?? 5],
  );
  return { id };
}

async function alreadyDelivered(client: PoolClient, idempotencyKey: string, exceptId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM security_sync.integration_queue WHERE idempotency_key=$1 AND status='delivered' AND id<>$2`, [idempotencyKey, exceptId]);
  return (r.rowCount ?? 0) > 0;
}

export type DrainResult = { attempted: number; delivered: number; retried: number; dead: number };

/**
 * Attempt delivery of queued items with bounded retry. Success → delivered;
 * failure increments attempts and, once max attempts are reached, moves the item
 * to the dead-letter state. Each item is row-locked so concurrent drains do not
 * double-deliver.
 */
export async function drainIntegrations(pool: Pool, deliver: Deliver, opts: { batch?: number } = {}): Promise<DrainResult> {
  const batch = opts.batch ?? 50;
  const out: DrainResult = { attempted: 0, delivered: 0, retried: 0, dead: 0 };
  const ids = (await pool.query(`SELECT id FROM security_sync.integration_queue WHERE status='queued' ORDER BY created_at LIMIT $1`, [batch])).rows.map((r) => r.id);

  for (const id of ids) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT id, kind, payload, idempotency_key, attempts, max_attempts, status FROM security_sync.integration_queue WHERE id=$1 FOR UPDATE`, [id]);
      const item = r.rows[0];
      if (!item || item.status !== 'queued') { await client.query('ROLLBACK'); continue; }
      out.attempted++;

      // Idempotency: if the same key already succeeded, mark this one delivered without re-calling.
      if (await alreadyDelivered(client, item.idempotency_key, item.id)) {
        await client.query(`UPDATE security_sync.integration_queue SET status='delivered', delivered_at=now() WHERE id=$1`, [item.id]);
        await client.query('COMMIT');
        out.delivered++;
        continue;
      }

      try {
        await deliver({ id: item.id, kind: item.kind, payload: item.payload, idempotencyKey: item.idempotency_key });
        await client.query(`UPDATE security_sync.integration_queue SET status='delivered', delivered_at=now(), attempts=attempts+1 WHERE id=$1`, [item.id]);
        out.delivered++;
      } catch (err) {
        const attempts = (item.attempts as number) + 1;
        const dead = attempts >= (item.max_attempts as number);
        await client.query(`UPDATE security_sync.integration_queue SET attempts=$2, last_error=$3, status=$4 WHERE id=$1`, [item.id, attempts, (err as Error).message.slice(0, 500), dead ? 'dead' : 'queued']);
        if (dead) {
          out.dead++;
          await client.query(
            `INSERT INTO audit.audit_event (id, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
             VALUES ($1,'config','integration_dead_letter',$2,'failure',$3, now(), $4)`,
            [uuidv7(), item.id, `${item.kind} dead-lettered after ${attempts} attempts: ${(err as Error).message.slice(0, 200)}`, 'dlq:' + item.id],
          );
        } else {
          out.retried++;
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return out;
}

/** Audited replay of a dead-lettered item (CLD-003). Idempotent and re-queues for delivery. */
export async function replayDeadLetter(pool: Pool, args: { id: string; by: string }, deliver: Deliver): Promise<{ id: string; status: 'delivered' | 'dead' | 'queued' }> {
  if (!args.by) throw new IntegrationError('replay requires an operator');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT id, kind, payload, idempotency_key, status FROM security_sync.integration_queue WHERE id=$1 FOR UPDATE`, [args.id]);
    const item = r.rows[0];
    if (!item) throw new IntegrationError(`integration ${args.id} not found`);
    if (item.status !== 'dead') throw new IntegrationError(`integration ${args.id} is ${item.status}, not dead`);

    let status: 'delivered' | 'dead' | 'queued' = 'dead';
    if (await alreadyDelivered(client, item.idempotency_key, item.id)) {
      await client.query(`UPDATE security_sync.integration_queue SET status='delivered', delivered_at=now() WHERE id=$1`, [item.id]);
      status = 'delivered';
    } else {
      try {
        await deliver({ id: item.id, kind: item.kind, payload: item.payload, idempotencyKey: item.idempotency_key });
        await client.query(`UPDATE security_sync.integration_queue SET status='delivered', delivered_at=now(), attempts=attempts+1 WHERE id=$1`, [item.id]);
        status = 'delivered';
      } catch (err) {
        await client.query(`UPDATE security_sync.integration_queue SET last_error=$2, attempts=attempts+1 WHERE id=$1`, [item.id, (err as Error).message.slice(0, 500)]);
        status = 'dead';
      }
    }
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','integration_replay',$3,$4,$5, now(), $6)`,
      [uuidv7(), args.by, item.id, status === 'delivered' ? 'success' : 'failure', `replay ${item.kind} → ${status}`, 'replay:' + item.id + ':' + uuidv7()],
    );
    await client.query('COMMIT');
    return { id: item.id, status };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function integrationQueueStatus(pool: Pool): Promise<{ queued: number; delivered: number; dead: number }> {
  const r = await pool.query(`SELECT status, count(*)::int AS n FROM security_sync.integration_queue GROUP BY status`);
  const out = { queued: 0, delivered: 0, dead: 0 };
  for (const row of r.rows) if (row.status in out) (out as Record<string, number>)[row.status] = row.n;
  return out;
}

export async function deadLetters(pool: Pool): Promise<Array<{ id: string; kind: string; attempts: number; lastError: string | null }>> {
  const r = await pool.query(`SELECT id, kind, attempts, last_error FROM security_sync.integration_queue WHERE status='dead' ORDER BY created_at`);
  return r.rows.map((x) => ({ id: x.id, kind: x.kind, attempts: x.attempts, lastError: x.last_error }));
}
