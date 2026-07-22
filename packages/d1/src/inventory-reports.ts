/**
 * Reorder suggestions + consumption/wastage reporting on D1 (INV-007, INV-011,
 * §12). Suggestions are advisory only (no auto-order); consumption and wastage are
 * derived from the immutable movement records, never stored totals. Ported from
 * the Postgres edge `inventory-reports.ts`.
 *
 * D1 translations: aggregate FILTER (WHERE ...) → SUM(CASE WHEN ... THEN ... END);
 * Postgres interval arithmetic (now() - N days) → a JS-computed ISO threshold
 * compared lexically (ISO-8601 sorts correctly as text).
 */
import { reorderSuggestion, type ReorderSuggestion } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many } from './query.ts';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19) + 'Z';
}

/**
 * Reorder suggestions across the product master (INV-007). On-hand is summed from
 * the derived balance; average daily use is estimated from dispensing over the
 * trailing window. Returns only products that warrant a reorder.
 */
export async function reorderSuggestions(db: D1Database, opts: { windowDays?: number } = {}): Promise<ReorderSuggestion[]> {
  const windowDays = opts.windowDays ?? 30;
  const threshold = isoDaysAgo(windowDays);
  const rows = await many<{ sku: string; reorder_min: number | null; reorder_max: number | null; on_hand: number; dispensed: number }>(
    db,
    `SELECT p.sku, p.reorder_min, p.reorder_max,
            COALESCE((SELECT SUM(on_hand) FROM inventory_stock_balance b WHERE b.sku = p.sku),0) AS on_hand,
            COALESCE((SELECT -SUM(quantity) FROM inventory_stock_movement m
                      WHERE m.sku = p.sku AND m.movement_type='dispense' AND m.occurred_at >= ?),0) AS dispensed
     FROM inventory_product p
     WHERE p.reorder_min IS NOT NULL`,
    [threshold],
  );
  return rows
    .map((x) => reorderSuggestion({
      sku: x.sku,
      onHand: Number(x.on_hand),
      reorderMin: Number(x.reorder_min),
      ...(x.reorder_max === null ? {} : { reorderMax: Number(x.reorder_max) }),
      ...(Number(x.dispensed) > 0 ? { avgDailyUse: Math.round((Number(x.dispensed) / windowDays) * 100) / 100 } : {}),
    }))
    .filter((s) => s.suggest);
}

export type MovementReportRow = { sku: string; name: string; receivedQty: number; dispensedQty: number; adjustmentQty: number; netQty: number };

/**
 * Consumption / wastage / receipt report over a period (INV-011). Quantities are
 * summed by movement type from the immutable movement records; negative
 * adjustments represent losses (wastage/variance).
 */
export async function stockMovementReport(db: D1Database, args: { from: string; to: string }): Promise<{ from: string; to: string; rows: MovementReportRow[] }> {
  const rows = await many<{ sku: string; name: string; received: number; dispensed: number; adjustment: number; net: number }>(
    db,
    `SELECT p.sku, p.name,
            COALESCE(SUM(CASE WHEN m.movement_type='receipt' THEN m.quantity END),0)     AS received,
            COALESCE(-SUM(CASE WHEN m.movement_type='dispense' THEN m.quantity END),0)   AS dispensed,
            COALESCE(SUM(CASE WHEN m.movement_type='adjustment' THEN m.quantity END),0)  AS adjustment,
            COALESCE(SUM(m.quantity),0) AS net
     FROM inventory_product p
     JOIN inventory_stock_movement m ON m.sku = p.sku
     WHERE m.occurred_at >= ? AND m.occurred_at < ?
     GROUP BY p.sku, p.name
     HAVING COUNT(m.id) > 0
     ORDER BY p.sku`,
    [args.from, args.to],
  );
  return {
    from: args.from,
    to: args.to,
    rows: rows.map((x) => ({ sku: x.sku, name: x.name, receivedQty: Number(x.received), dispensedQty: Number(x.dispensed), adjustmentQty: Number(x.adjustment), netQty: Number(x.net) })),
  };
}
