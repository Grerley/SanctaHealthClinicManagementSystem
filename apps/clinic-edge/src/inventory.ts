/**
 * Inventory receiving and stock alerts (INV-004/009). Goods receipt creates a lot
 * with its batch/expiry and landed cost, records the receipt as an immutable stock
 * movement, and posts Dr Inventory / Cr Supplier AP (pack §8.2). Stock alerts
 * derive low/stockout/near-expiry/expired signals from the movement ledger and
 * product reorder settings — each is an actionable queue item (INV-009).
 */
import type { Pool } from 'pg';
import { uuidv7, money, postGoodsReceivedOnCredit } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

export class InventoryError extends Error {}

const POSTING_DATE = '2026-07-19';

export async function receiveGoods(
  pool: Pool,
  args: { sku: string; expiryDate: string; unitCostMinor: number; quantity: number; supplier?: string; poRef?: string; location?: string; user?: string },
): Promise<{ lotId: string }> {
  if (args.quantity <= 0) throw new InventoryError('receipt quantity must be positive');
  if (args.unitCostMinor < 0) throw new InventoryError('unit cost cannot be negative');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prod = await client.query(`SELECT sku FROM inventory.product WHERE sku=$1`, [args.sku]);
    if (prod.rows.length === 0) throw new InventoryError(`unknown product ${args.sku}`);

    const lotId = uuidv7();
    await client.query(
      `INSERT INTO inventory.lot (id, sku, expiry_date, status, unit_cost_minor, supplier) VALUES ($1,$2,$3,'available',$4,$5)`,
      [lotId, args.sku, args.expiryDate, args.unitCostMinor, args.supplier ?? null],
    );
    await client.query(
      `INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES ($1,$2,$3,$4,'receipt',$5,$6)`,
      [uuidv7(), args.sku, lotId, args.location ?? 'MAIN', args.quantity, args.poRef ?? 'grn'],
    );
    // Dr Inventory / Cr Supplier AP at landed cost.
    const grnId = uuidv7();
    const journal = postGoodsReceivedOnCredit({ batchId: uuidv7(), postingDate: POSTING_DATE }, grnId, money(args.quantity * args.unitCostMinor));
    await insertJournalBatch(client, journal, POSTING_DATE.slice(0, 7));
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','goods_receipt',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.user ?? null, lotId, `${args.quantity} x ${args.sku}`, 'grn:' + lotId],
    );
    await client.query('COMMIT');
    return { lotId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type StockAlert = {
  sku: string;
  name: string;
  onHand: number;
  reorderMin: number | null;
  flags: string[]; // stockout | low | near_expiry | expired
};

/**
 * Compute stock alerts as of a date. Near-expiry window defaults to 60 days.
 * Expired/near-expiry are per-lot signals rolled up to the SKU.
 */
export async function stockAlerts(pool: Pool, asOf: string, nearExpiryDays = 60): Promise<StockAlert[]> {
  const products = await pool.query(`SELECT sku, name, reorder_min FROM inventory.product ORDER BY sku`);
  const alerts: StockAlert[] = [];
  for (const p of products.rows) {
    const onHandRes = await pool.query(`SELECT coalesce(sum(quantity),0)::int AS n FROM inventory.stock_movement WHERE sku=$1`, [p.sku]);
    const onHand = onHandRes.rows[0].n as number;
    const flags: string[] = [];
    if (onHand <= 0) flags.push('stockout');
    else if (p.reorder_min !== null && onHand < Number(p.reorder_min)) flags.push('low');

    // Per-lot expiry signals for lots that still have stock.
    const lots = await pool.query(
      `SELECT l.id, to_char(l.expiry_date,'YYYY-MM-DD') AS expiry,
              (SELECT coalesce(sum(quantity),0) FROM inventory.stock_movement m WHERE m.lot_id=l.id)::int AS on_hand
       FROM inventory.lot l WHERE l.sku=$1`,
      [p.sku],
    );
    const asOfMs = Date.parse(asOf);
    for (const lot of lots.rows) {
      if (Number(lot.on_hand) <= 0) continue;
      const expMs = Date.parse(lot.expiry);
      if (expMs < asOfMs && !flags.includes('expired')) flags.push('expired');
      else if (expMs - asOfMs <= nearExpiryDays * 86_400_000 && expMs >= asOfMs && !flags.includes('near_expiry')) flags.push('near_expiry');
    }

    if (flags.length > 0) alerts.push({ sku: p.sku, name: p.name, onHand, reorderMin: p.reorder_min === null ? null : Number(p.reorder_min), flags });
  }
  return alerts;
}
