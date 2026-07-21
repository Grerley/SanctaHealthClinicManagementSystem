/**
 * Selective replication scope (SYN-008, pack §14). A node only receives the
 * records it is entitled to and needs: constrained by site, record sensitivity
 * and an optional recency window. This keeps a peripheral site's replica minimal
 * (less data at rest on the edge) and enforces that sensitive records do not
 * propagate beyond their permitted scope. Pure decision logic — the transport
 * layer applies it when building a delta.
 */
import type { Sensitivity } from './patient-access.ts';

const SENSITIVITY_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, restricted: 2 };

export type ReplicationScope = {
  /** Sites this node may hold, or 'all' for a central node. */
  sites: string[] | 'all';
  /** Highest sensitivity this node may hold (inclusive). */
  maxSensitivity: Sensitivity;
  /** Only replicate records updated within this many days (omit = no window). */
  windowDays?: number;
};

export type ReplicableRecord = { siteId: string | null; sensitivity: Sensitivity; ageDays: number };

/**
 * Decide whether a record replicates to a node with the given scope (SYN-008).
 * Excluded if: the site is out of scope, the sensitivity exceeds the node's
 * ceiling, or the record is older than the recency window.
 */
export function shouldReplicate(record: ReplicableRecord, scope: ReplicationScope): boolean {
  if (scope.sites !== 'all') {
    if (record.siteId === null) return false; // site-scoped node cannot hold unsited records
    if (!scope.sites.includes(record.siteId)) return false;
  }
  if (SENSITIVITY_RANK[record.sensitivity] > SENSITIVITY_RANK[scope.maxSensitivity]) return false;
  if (scope.windowDays !== undefined && record.ageDays > scope.windowDays) return false;
  return true;
}

/** Partition candidate records into replicated / withheld for a scope (SYN-008). */
export function planReplication<T extends ReplicableRecord>(records: readonly T[], scope: ReplicationScope): { replicated: T[]; withheld: T[] } {
  const replicated: T[] = [];
  const withheld: T[] = [];
  for (const r of records) (shouldReplicate(r, scope) ? replicated : withheld).push(r);
  return { replicated, withheld };
}
