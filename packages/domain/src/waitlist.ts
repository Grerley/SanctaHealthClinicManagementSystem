/**
 * Waiting-list prioritisation (APT-004). When capacity is released (a cancellation
 * or no-show frees a slot), the freed slot is offered to the highest-priority
 * compatible entry — not simply the oldest. Ordering is deterministic: higher
 * clinical priority first, then first-come within the same priority, so the rule
 * is fair and reproducible. A slot only matches an entry whose requested service
 * is compatible (an unspecified service matches any).
 */
export type WaitlistEntry = {
  id: string;
  provider: string;
  serviceCode: string | null;
  priority: number; // higher = more urgent
  createdAt: string; // ISO — FIFO tiebreak within a priority
};

/** Deterministic order: priority desc, then oldest-first (FIFO) within a priority. */
export function orderWaitlist(entries: readonly WaitlistEntry[]): WaitlistEntry[] {
  return [...entries].sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

/** May a freed slot for `service` be offered to this entry? Unspecified requests match any. */
export function serviceMatches(entryService: string | null, slotService: string | null): boolean {
  if (entryService === null || entryService === undefined) return true;
  if (slotService === null || slotService === undefined) return true;
  return entryService === slotService;
}

/**
 * The entry a released slot should be offered to (APT-004), or null if none is
 * compatible. Considers only compatible entries and returns the top of the
 * priority order.
 */
export function nextWaitlistCandidate(
  entries: readonly WaitlistEntry[],
  slot: { provider: string; serviceCode: string | null },
): WaitlistEntry | null {
  const compatible = entries.filter((e) => e.provider === slot.provider && serviceMatches(e.serviceCode, slot.serviceCode));
  return orderWaitlist(compatible)[0] ?? null;
}
