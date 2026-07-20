/**
 * Stocktake with variance and approval (INV-008, UAT-11). A blind physical count
 * is compared to the book quantity (derived from the immutable movement ledger).
 * A non-zero variance requires an approver and posts BOTH a linked adjustment
 * movement (so the balance stays movement-derived, BR-007) and a balanced journal
 * (shrinkage expense or gain). The book is never edited directly.
 */
import type { Pool } from 'pg';
import { uuidv7, money, assertPostable, ACCOUNTS, type JournalBatch } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

export class StocktakeError extends Error {}

const POSTING_DATE = '2026-07-19';

export type StocktakeResult = { lotId: string; bookQty: number; countedQty: number; varianceQty: number; adjustmentValueMinor: number };

function adjustmentJournal(id: string, valueMinor: number, shrinkage: boolean): JournalBatch {
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
  const batch: JournalBatch = { id: uuidv7(), origin: 'system', source: { type: 'stocktake', id }, currency: 'USD', postingDate: POSTING_DATE, lines };
  assertPostable(batch);
  return batch;
}

export async function performStocktake(
  pool: Pool,
  args: { lotId: string; countedQty: number; approver?: string; user?: string; location?: string },
): Promise<StocktakeResult> {
  if (args.countedQty < 0) throw new StocktakeError('counted quantity cannot be negative');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lot = await client.query(`SELECT sku, unit_cost_minor FROM inventory.lot WHERE id=$1 FOR UPDATE`, [args.lotId]);
    if (lot.rows.length === 0) throw new StocktakeError('lot not found');
    const sku = lot.rows[0].sku as string;
    const unitCost = Number(lot.rows[0].unit_cost_minor);

    const bookRes = await client.query(`SELECT coalesce(sum(quantity),0)::int AS n FROM inventory.stock_movement WHERE lot_id=$1`, [args.lotId]);
    const bookQty = bookRes.rows[0].n as number;
    const varianceQty = args.countedQty - bookQty;
    const adjustmentValueMinor = Math.abs(varianceQty) * unitCost;

    if (varianceQty !== 0) {
      if (!args.approver) {
        await client.query('ROLLBACK');
        throw new StocktakeError(`stocktake variance ${varianceQty} requires an approver`);
      }
      // Linked adjustment movement keeps the balance movement-derived (BR-007).
      await client.query(
        `INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES ($1,$2,$3,$4,'adjustment',$5,$6)`,
        [uuidv7(), sku, args.lotId, args.location ?? 'MAIN', varianceQty, 'stocktake'],
      );
      const journal = adjustmentJournal(args.lotId, adjustmentValueMinor, varianceQty < 0);
      await insertJournalBatch(client, journal, POSTING_DATE.slice(0, 7));
      await client.query(
        `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
         VALUES ($1,$2,'approve','stocktake',$3,'success',$4, now(), $5)`,
        [uuidv7(), args.approver, args.lotId, `variance ${varianceQty} (${varianceQty < 0 ? 'shrinkage' : 'gain'})`, 'stocktake:' + uuidv7()],
      );
    }

    await client.query('COMMIT');
    return { lotId: args.lotId, bookQty, countedQty: args.countedQty, varianceQty, adjustmentValueMinor };
  } catch (e) {
    if (e instanceof StocktakeError) throw e;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
