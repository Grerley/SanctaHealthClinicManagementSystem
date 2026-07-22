/**
 * Inventory receiving and stock alerts on D1 (INV-004/009). Goods receipt creates
 * a lot with its batch/expiry and landed cost, records an immutable receipt
 * movement, maintains the balance (so dispense sees it), and posts Dr Inventory /
 * Cr Supplier-AP. Stock alerts derive low/stockout/near-expiry/expired from the
 * movement ledger + product reorder settings. Ported from the Postgres edge
 * `inventory.ts`.
 *
 * D1 translations: interactive tx → db.batch(); the balance upsert (absent in the
 * movement-only edge) keeps the maintained on-hand consistent for dispensing.
 */
import { uuidv7, money, postGoodsReceivedOnCredit } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';

export class InventoryError extends Error {}

/** Goods receipt on credit: create the lot, record the receipt, maintain the
 * balance, and post Dr Inventory / Cr Supplier-AP at landed cost. */
export async function receiveGoods(
  db: D1Database,
  args: { sku: string; expiryDate: string; unitCostMinor: number; quantity: number; supplier?: string; poRef?: string; location?: string; user?: string; postingDate?: string },
): Promise<{ lotId: string }> {
  if (args.quantity <= 0) throw new InventoryError('receipt quantity must be positive');
  if (args.unitCostMinor < 0) throw new InventoryError('unit cost cannot be negative');
  const prod = await one(db, `SELECT 1 AS ok FROM inventory_product WHERE sku=?`, [args.sku]);
  if (!prod) throw new InventoryError(`unknown product ${args.sku}`);
  const location = args.location ?? 'MAIN';
  const postingDate = args.postingDate ?? new Date().toISOString().slice(0, 10);
  const periodId = postingDate.slice(0, 7);
  await ensurePeriod(db, periodId);
  const lotId = uuidv7();
  const journal = postGoodsReceivedOnCredit({ batchId: uuidv7(), postingDate }, uuidv7(), money(args.quantity * args.unitCostMinor));
  await db.batch([
    stmt(db, `INSERT INTO inventory_lot (id, sku, expiry_date, status, unit_cost_minor, supplier) VALUES (?,?,?,'available',?,?)`, [lotId, args.sku, args.expiryDate, args.unitCostMinor, args.supplier ?? null]),
    stmt(db, `INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES (?,?,?,?,'receipt',?,?)`, [uuidv7(), args.sku, lotId, location, args.quantity, args.poRef ?? 'grn']),
    stmt(db, `INSERT INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES (?,?,?,?) ON CONFLICT(lot_id, location) DO UPDATE SET on_hand = on_hand + excluded.on_hand`, [lotId, location, args.sku, args.quantity]),
    ...journalStatements(db, journal, periodId),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'create','goods_receipt',?,'success',?,?)`, [uuidv7(), args.user ?? null, lotId, `${args.quantity} x ${args.sku}`, 'grn:' + lotId]),
  ]);
  return { lotId };
}

export type StockAlert = { sku: string; name: string; onHand: number; reorderMin: number | null; flags: string[] };

/** Stock alerts as-of a date (near-expiry window defaults to 60 days). Expired /
 * near-expiry are per-lot signals rolled up to the SKU. */
export async function stockAlerts(db: D1Database, asOf: string, nearExpiryDays = 60): Promise<StockAlert[]> {
  const products = await many<{ sku: string; name: string; reorder_min: number | null }>(db, `SELECT sku, name, reorder_min FROM inventory_product ORDER BY sku`);
  const asOfMs = Date.parse(asOf);
  const alerts: StockAlert[] = [];
  for (const p of products) {
    const onHandRow = await one<{ n: number }>(db, `SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock_movement WHERE sku=?`, [p.sku]);
    const onHand = Number(onHandRow?.n ?? 0);
    const flags: string[] = [];
    if (onHand <= 0) flags.push('stockout');
    else if (p.reorder_min !== null && onHand < Number(p.reorder_min)) flags.push('low');
    const lots = await many<{ id: string; expiry: string; on_hand: number }>(db,
      `SELECT l.id, l.expiry_date AS expiry, (SELECT COALESCE(SUM(quantity),0) FROM inventory_stock_movement m WHERE m.lot_id=l.id) AS on_hand FROM inventory_lot l WHERE l.sku=?`, [p.sku]);
    for (const lot of lots) {
      if (Number(lot.on_hand) <= 0) continue;
      const expMs = Date.parse(lot.expiry);
      if (expMs < asOfMs && !flags.includes('expired')) flags.push('expired');
      else if (expMs - asOfMs <= nearExpiryDays * 86_400_000 && expMs >= asOfMs && !flags.includes('near_expiry')) flags.push('near_expiry');
    }
    if (flags.length > 0) alerts.push({ sku: p.sku, name: p.name, onHand, reorderMin: p.reorder_min === null ? null : Number(p.reorder_min), flags });
  }
  return alerts;
}
