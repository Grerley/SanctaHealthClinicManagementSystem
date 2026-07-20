/**
 * Reorder suggestions + consumption/wastage reporting (INV-007, INV-011,
 * pack §12). Suggestions are advisory only (no auto-order); consumption and
 * wastage are derived from the immutable movement records, never stored totals.
 */
import type { Pool } from 'pg';
import { reorderSuggestion, type ReorderSuggestion } from '@sancta/domain';

/**
 * Reorder suggestions across the product master (INV-007). On-hand is summed from
 * the derived balance view; average daily use is estimated from dispensing over
 * the trailing window. Returns only products that warrant a reorder.
 */
export async function reorderSuggestions(pool: Pool, opts: { windowDays?: number } = {}): Promise<ReorderSuggestion[]> {
  const windowDays = opts.windowDays ?? 30;
  const r = await pool.query(
    `SELECT p.sku, p.reorder_min, p.reorder_max,
            coalesce((SELECT sum(on_hand) FROM inventory.stock_balance b WHERE b.sku = p.sku),0)::bigint AS on_hand,
            coalesce((SELECT -sum(quantity) FROM inventory.stock_movement m
                      WHERE m.sku = p.sku AND m.movement_type='dispense' AND m.occurred_at >= now() - ($1 || ' days')::interval),0)::bigint AS dispensed
     FROM inventory.product p
     WHERE p.reorder_min IS NOT NULL`,
    [String(windowDays)],
  );
  return r.rows
    .map((x) => reorderSuggestion({
      sku: x.sku,
      onHand: Number(x.on_hand),
      reorderMin: x.reorder_min,
      ...(x.reorder_max === null ? {} : { reorderMax: x.reorder_max }),
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
export async function stockMovementReport(pool: Pool, args: { from: string; to: string }): Promise<{ from: string; to: string; rows: MovementReportRow[] }> {
  const r = await pool.query(
    `SELECT p.sku, p.name,
            coalesce(sum(m.quantity) FILTER (WHERE m.movement_type='receipt'),0)::bigint    AS received,
            coalesce(-sum(m.quantity) FILTER (WHERE m.movement_type='dispense'),0)::bigint   AS dispensed,
            coalesce(sum(m.quantity) FILTER (WHERE m.movement_type='adjustment'),0)::bigint  AS adjustment,
            coalesce(sum(m.quantity),0)::bigint AS net
     FROM inventory.product p
     JOIN inventory.stock_movement m ON m.sku = p.sku
     WHERE m.occurred_at >= $1 AND m.occurred_at < $2
     GROUP BY p.sku, p.name
     HAVING count(m.id) > 0
     ORDER BY p.sku`,
    [args.from, args.to],
  );
  return {
    from: args.from,
    to: args.to,
    rows: r.rows.map((x) => ({ sku: x.sku, name: x.name, receivedQty: Number(x.received), dispensedQty: Number(x.dispensed), adjustmentQty: Number(x.adjustment), netQty: Number(x.net) })),
  };
}
