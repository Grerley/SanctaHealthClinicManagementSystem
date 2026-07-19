/**
 * Outbox + idempotent apply (SYN-003, CLD-003, NFR-010, ADR-0004).
 *
 * Every locally committed transaction writes an OutboxItem atomically with the
 * domain change and audit event. The cloud deduplicates by idempotency key so
 * retry / duplicate delivery NEVER creates a duplicate business transaction.
 */

export type OutboxItem = {
  readonly idempotencyKey: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly entityVersion: number;
  readonly originSite: string;
  readonly device: string;
  readonly user: string;
  readonly schemaVersion: number;
  readonly priority: number;
  /** Idempotency keys this item depends on (apply-after ordering). */
  readonly dependencies: readonly string[];
  readonly capturedAt: string; // device clock
  readonly payload: unknown;
};

export type ApplyOutcome =
  | { readonly status: 'applied'; readonly key: string }
  | { readonly status: 'duplicate'; readonly key: string }
  | { readonly status: 'deferred'; readonly key: string; readonly missing: readonly string[] };

/**
 * Idempotent applier. `seen` is the durable set of already-applied idempotency
 * keys on the receiving side (in production, a uniqueness constraint in
 * PostgreSQL). Applying the same item twice yields 'duplicate' and no effect.
 */
export class IdempotentApplier {
  readonly #seen: Set<string>;
  readonly #applied: OutboxItem[] = [];

  constructor(seen: Iterable<string> = []) {
    this.#seen = new Set(seen);
  }

  has(key: string): boolean {
    return this.#seen.has(key);
  }

  get appliedCount(): number {
    return this.#applied.length;
  }

  apply(item: OutboxItem): ApplyOutcome {
    if (this.#seen.has(item.idempotencyKey)) {
      return { status: 'duplicate', key: item.idempotencyKey };
    }
    const missing = item.dependencies.filter((d) => !this.#seen.has(d));
    if (missing.length > 0) {
      return { status: 'deferred', key: item.idempotencyKey, missing };
    }
    this.#seen.add(item.idempotencyKey);
    this.#applied.push(item);
    return { status: 'applied', key: item.idempotencyKey };
  }

  /**
   * Apply a batch, retrying deferred items until no progress is made (resolves
   * dependency ordering regardless of transmit order). Returns per-key outcomes.
   */
  applyBatch(items: readonly OutboxItem[]): ApplyOutcome[] {
    const pending = items.slice();
    const outcomes: ApplyOutcome[] = [];
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i] as OutboxItem;
        const outcome = this.apply(item);
        if (outcome.status !== 'deferred') {
          outcomes.push(outcome);
          pending.splice(i, 1);
          progress = true;
        }
      }
    }
    // anything still pending is unresolved-dependency deferred
    for (const item of pending) {
      const missing = item.dependencies.filter((d) => !this.#seen.has(d));
      outcomes.push({ status: 'deferred', key: item.idempotencyKey, missing });
    }
    return outcomes;
  }
}

/** Flag a device clock that drifts beyond threshold vs authoritative time (SYN-007). */
export function clockDriftFlag(capturedAtMs: number, receivedAtMs: number, thresholdMs = 5 * 60 * 1000): boolean {
  return Math.abs(receivedAtMs - capturedAtMs) > thresholdMs;
}
