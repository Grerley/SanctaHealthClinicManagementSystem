/**
 * @sancta/sync — edge → cloud synchronisation engine (ADR-0004, SYN-003/004/010).
 *
 * The engine is framework-neutral: it depends on two pluggable ports so the same
 * logic runs over PostgreSQL + HTTPS in production and over in-memory fakes in
 * tests. It never blocks foreground work; a transport failure leaves items queued
 * for the next attempt (bounded retry is the caller's schedule). Because the cloud
 * dedups by idempotency key, retry / duplicate delivery never double-applies.
 */
import type { OutboxItem } from '@sancta/domain';

export { HttpSyncTransport } from './http-transport.ts';

/** The durable receipt the cloud returns after a batch is applied (SYN step 6). */
export type SyncReceipt = {
  readonly originSite: string;
  readonly applied: readonly string[];
  readonly duplicates: readonly string[];
  readonly deferred: readonly string[];
  readonly durable: true;
};

/** Transport port: how a batch reaches the cloud (HTTPS in prod). */
export interface SyncTransport {
  send(batch: { originSite: string; alreadySynced?: readonly string[]; items: readonly OutboxItem[] }): Promise<SyncReceipt>;
}

/** Store port: how the engine reads/updates the local outbox. */
export interface OutboxStore {
  /** Oldest queued items by (priority, capturedAt), up to `limit`. */
  takeQueued(limit: number): Promise<readonly OutboxItem[]>;
  /** Mark items durably synchronised (only after a durable cloud receipt). */
  markAcknowledged(keys: readonly string[]): Promise<void>;
  /** Record a failed attempt; items stay queued for retry. */
  markFailedAttempt(keys: readonly string[], error: string): Promise<void>;
}

export type PushResult = {
  readonly attempted: number;
  readonly acknowledged: number;
  readonly deferred: number;
  readonly failed: number;
  readonly transportError?: string;
};

/**
 * Push one drain pass: take queued items, send them, and acknowledge those the
 * cloud applied or recognised as duplicates (both are durably present centrally).
 * Deferred items (unresolved dependencies) stay queued. A transport failure marks
 * a failed attempt and leaves everything queued — nothing is lost (SYN-002/004).
 */
export async function pushOnce(store: OutboxStore, transport: SyncTransport, originSite: string, batchSize = 100): Promise<PushResult> {
  const items = await store.takeQueued(batchSize);
  if (items.length === 0) return { attempted: 0, acknowledged: 0, deferred: 0, failed: 0 };

  let receipt: SyncReceipt;
  try {
    receipt = await transport.send({ originSite, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.markFailedAttempt(items.map((i) => i.idempotencyKey), msg);
    return { attempted: items.length, acknowledged: 0, deferred: 0, failed: items.length, transportError: msg };
  }

  // Applied AND duplicates are durably present centrally -> acknowledge both.
  const done = [...receipt.applied, ...receipt.duplicates];
  if (done.length > 0) await store.markAcknowledged(done);

  return { attempted: items.length, acknowledged: done.length, deferred: receipt.deferred.length, failed: 0 };
}

/**
 * Drain the outbox until it is empty or no progress is made (bulk reconnect after
 * an outage, SYN step 3-6). Returns cumulative totals. Guards against an infinite
 * loop if items keep deferring.
 */
export async function drain(store: OutboxStore, transport: SyncTransport, originSite: string, batchSize = 100, maxPasses = 1000): Promise<PushResult> {
  let attempted = 0;
  let acknowledged = 0;
  let deferred = 0;
  let failed = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const r = await pushOnce(store, transport, originSite, batchSize);
    attempted += r.attempted;
    acknowledged += r.acknowledged;
    failed += r.failed;
    deferred = r.deferred;
    if (r.attempted === 0) break; // outbox drained
    if (r.acknowledged === 0) break; // no progress (all deferred or a transport failure)
  }
  return { attempted, acknowledged, deferred, failed };
}
