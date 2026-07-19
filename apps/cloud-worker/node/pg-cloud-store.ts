/**
 * pg-backed CloudStore for the canonical cloud PostgreSQL (CLD-004). Used by the
 * Node cloud adapter in dev/test; in production the Worker uses an equivalent
 * store over a cache-disabled Hyperdrive binding (CLD-005). Durable idempotency
 * is a PRIMARY KEY on the idempotency key — the DB is the no-duplicate guarantee.
 */
import type { Pool } from 'pg';
import type { OutboxItem } from '@sancta/domain';
import type { CloudStore } from '../src/cloud-sync.ts';

export const CLOUD_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS cloud;
CREATE TABLE IF NOT EXISTS cloud.applied_change (
  idempotency_key text PRIMARY KEY,
  applied_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud.synced_checkout (
  idempotency_key text PRIMARY KEY REFERENCES cloud.applied_change(idempotency_key),
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  origin_site     text NOT NULL,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
`;

export class PgCloudStore implements CloudStore {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(CLOUD_SCHEMA_SQL);
  }

  async knownKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set();
    const res = await this.#pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM cloud.applied_change WHERE idempotency_key = ANY($1)`,
      [keys],
    );
    return new Set(res.rows.map((r) => r.idempotency_key));
  }

  async recordApplied(item: OutboxItem): Promise<void> {
    // Single transaction; ON CONFLICT DO NOTHING makes concurrent/duplicate
    // delivery a no-op even under a race (NFR-010).
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO cloud.applied_change (idempotency_key) VALUES ($1) ON CONFLICT DO NOTHING`, [
        item.idempotencyKey,
      ]);
      await client.query(
        `INSERT INTO cloud.synced_checkout (idempotency_key, entity_type, entity_id, origin_site, payload)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [item.idempotencyKey, item.entityType, item.entityId, item.originSite, JSON.stringify(item.payload)],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
