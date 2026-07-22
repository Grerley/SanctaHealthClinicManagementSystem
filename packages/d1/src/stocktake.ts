/**
 * Stocktake with variance and approval on D1 (INV-008, UAT-11). A blind physical
 * count is compared to the book quantity (the maintained, movement-derived balance
 * for the lot/location). A non-zero variance requires an approver and posts BOTH a
 * linked adjustment movement (so the balance stays movement-derived, BR-007) and a
 * balanced journal (shrinkage expense or gain). The book is never edited directly.
 * Ported from the Postgres edge `stocktake.ts`.
 *
 * D1 translations: interactive tx + FOR UPDATE → one db.batch (movement + balance
 * update guarded by CHECK(on_hand>=0) + journal + audit post atomically); period-
 * open is asserted before posting (BR-010).
 */
import { uuidv7, money, assertPostable, ACCOUNTS, type JournalBatch } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';
import { assertPeriodOpen } from './finance.ts';

export class StocktakeError extends Error {}

function today(): string { return new Date().toISOString().slice(0, 10); }

export type StocktakeResult = { lotId: string; bookQty: number; countedQty: number; varianceQty: number; adjustmentValueMinor: number };

function adjustmentJournal(id: string, valueMinor: number, shrinkage: boolean, postingDate: string): JournalBatch {
  const amount = money(valueMinor);
  const zero = money(0);
  // Shrinkage: Dr supplies/shrinkage expense, Cr inventory. Gain: the reverse.
  const lines = shrinkage
    ? [
        { accountCode: ACCOUNTS.suppliesExpense, debit: amount, credit: zero },
        { accountCode: ACCOUNTS.inventory, debit: zero, credit: amount },
      ]
    : [
        { accountCode: ACCOUNTS.inventory, debit: amount, credit: zero },
        { accountCode: ACCOUNTS.suppliesExpense, debit: zero, credit: amount },
      ];
  const batch: JournalBatch = { id: uuidv7(), origin: 'system', source: { type: 'stocktake', id }, currency: 'USD', postingDate, lines };
  assertPostable(batch);
  return batch;
}

export async function performStocktake(
  db: D1Database,
  args: { lotId: string; countedQty: number; approver?: string; user?: string; location?: string; postingDate?: string },
): Promise<StocktakeResult> {
  if (args.countedQty < 0) throw new StocktakeError('counted quantity cannot be negative');
  const location = args.location ?? 'MAIN';
  const lot = await one<{ sku: string; unit_cost_minor: number }>(db, `SELECT sku, unit_cost_minor FROM inventory_lot WHERE id=?`, [args.lotId]);
  if (!lot) throw new StocktakeError('lot not found');
  const unitCost = Number(lot.unit_cost_minor);

  // Book quantity is the movement-derived balance for this lot/location.
  const book = await one<{ n: number }>(db, `SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock_movement WHERE lot_id=? AND location=?`, [args.lotId, location]);
  const bookQty = Number(book?.n ?? 0);
  const varianceQty = args.countedQty - bookQty;
  const adjustmentValueMinor = Math.abs(varianceQty) * unitCost;

  if (varianceQty === 0) {
    return { lotId: args.lotId, bookQty, countedQty: args.countedQty, varianceQty, adjustmentValueMinor };
  }
  if (!args.approver) throw new StocktakeError(`stocktake variance ${varianceQty} requires an approver`);

  const postingDate = args.postingDate ?? today();
  const period = postingDate.slice(0, 7);
  await ensurePeriod(db, period);
  await assertPeriodOpen(db, period);
  const journal = adjustmentJournal(args.lotId, adjustmentValueMinor, varianceQty < 0, postingDate);

  await db.batch([
    // Linked adjustment movement keeps the balance movement-derived (BR-007).
    stmt(db, `INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES (?,?,?,?,'adjustment',?,?)`,
      [uuidv7(), lot.sku, args.lotId, location, varianceQty, 'stocktake']),
    // The physical count becomes the maintained balance (CHECK(on_hand>=0) guards).
    stmt(db, `INSERT INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES (?,?,?,?)
      ON CONFLICT(lot_id, location) DO UPDATE SET on_hand = ?`,
      [args.lotId, location, lot.sku, args.countedQty, args.countedQty]),
    ...journalStatements(db, journal, period),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','stocktake',?,'success',?,?)`,
      [uuidv7(), args.approver, args.lotId, `variance ${varianceQty} (${varianceQty < 0 ? 'shrinkage' : 'gain'})`, 'stocktake:' + uuidv7()]),
  ]);
  return { lotId: args.lotId, bookQty, countedQty: args.countedQty, varianceQty, adjustmentValueMinor };
}
