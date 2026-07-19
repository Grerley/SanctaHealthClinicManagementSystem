/**
 * Durable cloud-side sync apply (SYN step 5-6, CLD-003/004). Applies an outbox
 * batch against the canonical cloud store idempotently and returns a durable
 * receipt. The same service runs in the Worker (Hyperdrive-backed store) and in
 * the Node test adapter (pg-backed store) — the dedup rule is defined once.
 */
import { IdempotentApplier, type OutboxItem, type ApplyOutcome } from '@sancta/domain';
import { parseRequest, type SyncReceipt } from './sync-ingress.ts';

/** Cloud store port: durable idempotency + application of a synced change. */
export interface CloudStore {
  /** Keys already durably applied centrally (seeds the applier). */
  knownKeys(keys: readonly string[]): Promise<ReadonlySet<string>>;
  /** Durably record a newly-applied change (idempotency key is the anchor). */
  recordApplied(item: OutboxItem): Promise<void>;
}

export class CloudSyncService {
  readonly #store: CloudStore;
  constructor(store: CloudStore) {
    this.#store = store;
  }

  async apply(body: unknown): Promise<SyncReceipt> {
    const req = parseRequest(body);
    const keys = req.items.map((i) => i.idempotencyKey);
    const seen = await this.#store.knownKeys(keys);
    const applier = new IdempotentApplier(seen);
    const outcomes: ApplyOutcome[] = applier.applyBatch(req.items);

    // Persist newly-applied items durably before acknowledging (SYN step 6).
    const byKey = new Map(req.items.map((i) => [i.idempotencyKey, i]));
    for (const o of outcomes) {
      if (o.status === 'applied') {
        const item = byKey.get(o.key);
        if (item) await this.#store.recordApplied(item);
      }
    }

    return {
      originSite: req.originSite,
      applied: outcomes.filter((o) => o.status === 'applied').map((o) => o.key),
      duplicates: outcomes.filter((o) => o.status === 'duplicate').map((o) => o.key),
      deferred: outcomes.filter((o) => o.status === 'deferred').map((o) => o.key),
      durable: true,
    };
  }
}
