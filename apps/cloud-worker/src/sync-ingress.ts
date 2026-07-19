/**
 * Synchronisation ingress (SYN protocol steps 4-6, ADR-0004). Validates and
 * applies an outbox batch idempotently, then returns a durable receipt the edge
 * reconciles against. Reuses the shared domain applier so the dedup rule is
 * defined once (NFR-010) — retry/replay never duplicates a business transaction.
 *
 * This skeleton applies against an in-memory applier seeded from the request's
 * declared already-synced keys; the production path swaps that for a PostgreSQL
 * uniqueness constraint via a cache-disabled Hyperdrive binding (CLD-004/005).
 */
import { type OutboxItem, IdempotentApplier, type ApplyOutcome } from '@sancta/domain';

export type SyncIngressRequest = {
  readonly originSite: string;
  readonly alreadySynced?: readonly string[];
  readonly items: readonly OutboxItem[];
};

export type SyncReceipt = {
  readonly originSite: string;
  readonly applied: readonly string[];
  readonly duplicates: readonly string[];
  readonly deferred: readonly string[];
  readonly durable: true;
};

function isOutboxItem(v: unknown): v is OutboxItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['idempotencyKey'] === 'string' &&
    typeof o['entityType'] === 'string' &&
    typeof o['entityId'] === 'string' &&
    Array.isArray(o['dependencies'])
  );
}

export function parseRequest(body: unknown): SyncIngressRequest {
  if (typeof body !== 'object' || body === null) throw new Error('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b['originSite'] !== 'string') throw new Error('originSite required');
  if (!Array.isArray(b['items']) || !b['items'].every(isOutboxItem)) throw new Error('items invalid');
  const already = Array.isArray(b['alreadySynced']) ? (b['alreadySynced'] as string[]) : [];
  return { originSite: b['originSite'], alreadySynced: already, items: b['items'] as OutboxItem[] };
}

export function handleSyncIngress(body: unknown): SyncReceipt {
  const req = parseRequest(body);
  const applier = new IdempotentApplier(req.alreadySynced ?? []);
  const outcomes: ApplyOutcome[] = applier.applyBatch(req.items);
  return {
    originSite: req.originSite,
    applied: outcomes.filter((o) => o.status === 'applied').map((o) => o.key),
    duplicates: outcomes.filter((o) => o.status === 'duplicate').map((o) => o.key),
    deferred: outcomes.filter((o) => o.status === 'deferred').map((o) => o.key),
    durable: true,
  };
}
