/**
 * Stock receipt & FEFO dispense on D1 (INV-005/006) — the concurrency-critical
 * path, ported from the Postgres row-lock version to the D1 optimistic pattern.
 *
 * The FEFO allocation is the SAME domain function (`fefoPick`) used everywhere;
 * only the persistence changes. A dispense commits as one atomic `batch()`:
 * append the immutable movement(s) AND decrement the maintained balance row(s).
 * The `CHECK (on_hand >= 0)` on the balance is the gate — a concurrent over-draw
 * makes the batch fail and roll back, so stock can never go negative without a
 * lock. This is the pattern every interactive write in the app will follow.
 */
import { fefoPick, planCostMinor, StockError, uuidv7, type Lot, type StockMovement } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many, one, stmt } from './query.ts';

type BalanceRow = { lot_id: string; location: string; on_hand: number };
type LotRow = { id: string; sku: string; expiry_date: string; status: string; unit_cost_minor: number };

/** Receive stock into a lot (increments the balance; appends a receipt movement). */
export async function receiveStock(
  db: D1Database,
  args: { sku: string; lotId: string; expiryDate: string; unitCostMinor: number; location: string; quantity: number; supplier?: string },
): Promise<void> {
  if (args.quantity <= 0) throw new StockError('receipt quantity must be positive');
  await db.prepare(`INSERT INTO inventory_lot (id, sku, expiry_date, status, unit_cost_minor, supplier) VALUES (?,?,?,'available',?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(args.lotId, args.sku, args.expiryDate, args.unitCostMinor, args.supplier ?? null)
    .run();
  await db.batch([
    stmt(db, `INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES (?,?,?,?,'receipt',?, 'receipt')`,
      [uuidv7(), args.sku, args.lotId, args.location, args.quantity]),
    stmt(db, `INSERT INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES (?,?,?,?)
              ON CONFLICT(lot_id, location) DO UPDATE SET on_hand = on_hand + excluded.on_hand`,
      [args.lotId, args.location, args.sku, args.quantity]),
  ]);
}

/** On-hand for a SKU at a location (Σ balances). */
export async function skuOnHand(db: D1Database, sku: string, location: string): Promise<number> {
  const r = await one<{ n: number }>(db, `SELECT COALESCE(SUM(on_hand),0) AS n FROM inventory_stock_balance WHERE sku=? AND location=?`, [sku, location]);
  return Number(r?.n ?? 0);
}

export type DispenseResult = { plan: ReadonlyArray<{ lotId: string; quantity: number; unitCostMinor: number }>; cogsMinor: number };

/**
 * FEFO-dispense `quantity` of `sku` at `location` (INV-005/006). Reuses the domain
 * FEFO planner, then commits every lot decrement + its movement in one atomic
 * batch. Throws StockError if stock is insufficient — either at plan time
 * (domain) or at commit time (the CHECK gate, under a lost concurrency race).
 */
export async function dispenseStock(
  db: D1Database,
  args: { sku: string; location: string; quantity: number; asOfDate: string; sourceRef?: string; movementType?: string },
): Promise<DispenseResult> {
  const lotRows = await many<LotRow>(db, `SELECT id, sku, expiry_date, status, unit_cost_minor FROM inventory_lot WHERE sku=?`, [args.sku]);
  const balances = await many<BalanceRow>(db, `SELECT lot_id, location, on_hand FROM inventory_stock_balance WHERE sku=? AND location=?`, [args.sku, args.location]);

  const lots: Lot[] = lotRows.map((l) => ({ id: l.id, sku: l.sku, expiryDate: l.expiry_date, status: l.status as Lot['status'], unitCostMinor: Number(l.unit_cost_minor) }));
  // Express current balances as synthetic movements so the domain FEFO planner
  // (which sums movements) sees the live on-hand per lot.
  const movements: StockMovement[] = balances.map((b) => ({ id: '', sku: args.sku, lotId: b.lot_id, location: b.location, type: 'receipt', quantity: Number(b.on_hand), occurredAt: '' }));

  const plan = fefoPick(lots, movements, args.sku, args.quantity, args.asOfDate); // throws StockError if short

  const type = args.movementType ?? 'dispense';
  const statements = plan.flatMap((p) => [
    stmt(db, `INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES (?,?,?,?,?,?,?)`,
      [uuidv7(), args.sku, p.lotId, args.location, type, -p.quantity, args.sourceRef ?? null]),
    stmt(db, `UPDATE inventory_stock_balance SET on_hand = on_hand - ? WHERE lot_id=? AND location=?`, [p.quantity, p.lotId, args.location]),
  ]);

  try {
    await db.batch(statements);
  } catch (e) {
    // CHECK(on_hand >= 0) tripped: a concurrent dispense drew the lot down first.
    if (String((e as Error).message).match(/CHECK|constraint/i)) {
      throw new StockError(`insufficient stock for ${args.sku} — lost a concurrency race; retry`);
    }
    throw e;
  }
  return { plan, cogsMinor: planCostMinor(plan) };
}
