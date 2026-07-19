/**
 * Shared helper to persist a balanced JournalBatch (FIN-002) to the edge
 * PostgreSQL. Used by the checkout and cashier flows so posting is written one
 * way. Callers pass a client already inside a transaction.
 */
import type { PoolClient } from 'pg';
import { uuidv7, type JournalBatch } from '@sancta/domain';
import { ensurePeriod, assertPeriodOpen } from './finance.ts';

export async function insertJournalBatch(client: PoolClient, batch: JournalBatch, periodId: string): Promise<void> {
  // Posting choke point: auto-create the period, then reject if it is closed
  // (BR-010, FIN-009). Runs inside the caller's transaction so a rejection rolls
  // the whole business transaction back.
  await ensurePeriod(client, periodId);
  await assertPeriodOpen(client, periodId);
  await client.query(
    `INSERT INTO finance.journal_batch (id, origin, source_type, source_id, currency, posting_date, period_id, reverses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [batch.id, batch.origin, batch.source.type, batch.source.id, batch.currency, batch.postingDate, periodId, batch.reverses ?? null],
  );
  for (const l of batch.lines) {
    await client.query(
      `INSERT INTO finance.journal_line (id, batch_id, account_code, debit_minor, credit_minor, cost_centre, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), batch.id, l.accountCode, l.debit.minor, l.credit.minor, l.costCentre ?? null, l.memo ?? null],
    );
  }
}
