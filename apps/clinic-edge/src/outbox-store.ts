/**
 * pg-backed OutboxStore for the clinic edge (SYN-003/004). Reads queued items
 * oldest-first by priority and marks them acknowledged only after a durable cloud
 * receipt. Failed attempts leave items queued for the next drain (nothing lost).
 */
import type { Pool } from 'pg';
import type { OutboxItem } from '@sancta/domain';
import type { OutboxStore } from '@sancta/sync';

export class PgOutboxStore implements OutboxStore {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async takeQueued(limit: number): Promise<readonly OutboxItem[]> {
    const res = await this.#pool.query(
      `SELECT idempotency_key, entity_type, entity_id, entity_version, origin_site, device_id, user_id,
              schema_version, priority, dependencies, to_char(captured_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at, payload
       FROM security_sync.outbox_item
       WHERE sync_state = 'queued'
       ORDER BY priority ASC, captured_at ASC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityVersion: Number(r.entity_version),
      originSite: r.origin_site,
      device: r.device_id,
      user: r.user_id,
      schemaVersion: Number(r.schema_version),
      priority: Number(r.priority),
      dependencies: r.dependencies ?? [],
      capturedAt: r.captured_at,
      payload: r.payload,
    }));
  }

  async markAcknowledged(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.#pool.query(
      `UPDATE security_sync.outbox_item SET sync_state='acknowledged', received_at=now() WHERE idempotency_key = ANY($1)`,
      [keys],
    );
  }

  async markFailedAttempt(keys: readonly string[], _error: string): Promise<void> {
    // Items remain 'queued' for the next drain. A retry-count/backoff column can
    // be added when bounded-retry telemetry is wired (NFR-036); nothing is lost.
    if (keys.length === 0) return;
  }

  async pendingCount(): Promise<number> {
    const res = await this.#pool.query(`SELECT count(*)::int AS n FROM security_sync.outbox_item WHERE sync_state='queued'`);
    return res.rows[0].n as number;
  }
}
