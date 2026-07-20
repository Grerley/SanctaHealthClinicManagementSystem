/**
 * Reorder suggestions (INV-007, pack §12.4). A SUGGESTION only — the system never
 * auto-orders. When on-hand falls to or below the reorder minimum, it proposes a
 * quantity to bring stock up to the maximum, and returns the assumptions behind
 * the number (min, max, usage) so a human can judge it. Days-of-cover is shown
 * when an average daily usage is known.
 */

export type ReorderInput = {
  sku: string;
  onHand: number;
  reorderMin?: number;
  reorderMax?: number;
  avgDailyUse?: number;
};

export type ReorderSuggestion = {
  sku: string;
  suggest: boolean;
  suggestedQty: number;
  coverDays: number | null;
  assumptions: { reorderMin: number | null; reorderMax: number | null; avgDailyUse: number | null };
};

export function reorderSuggestion(input: ReorderInput): ReorderSuggestion {
  const reorderMin = input.reorderMin ?? null;
  const reorderMax = input.reorderMax ?? null;
  const avgDailyUse = input.avgDailyUse ?? null;

  const suggest = reorderMin !== null && input.onHand <= reorderMin;
  // Bring up to max (or twice the min if no max is configured).
  const target = reorderMax ?? (reorderMin !== null ? reorderMin * 2 : input.onHand);
  const suggestedQty = suggest ? Math.max(0, target - input.onHand) : 0;
  const coverDays = avgDailyUse && avgDailyUse > 0 ? Math.floor(input.onHand / avgDailyUse) : null;

  return { sku: input.sku, suggest, suggestedQty, coverDays, assumptions: { reorderMin, reorderMax, avgDailyUse } };
}
