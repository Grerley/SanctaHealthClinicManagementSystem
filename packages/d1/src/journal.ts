/**
 * Shared double-entry journal persistence for D1 (FIN-002). Turns a balanced
 * domain JournalBatch into the INSERT statements for finance_journal_batch + its
 * lines, so every posting path (checkout, billing, cashier, …) writes the ledger
 * ONE way. Kept separate so the whole app posts through a single choke point.
 */
import { uuidv7, type JournalBatch } from '@sancta/domain';
import type { D1Database, D1PreparedStatement } from './d1.ts';
import { run, stmt } from './query.ts';

/** Ensure the accounting period row exists (idempotent; not part of an atomic unit). */
export async function ensurePeriod(db: D1Database, periodId: string): Promise<void> {
  await run(db, `INSERT INTO finance_financial_period (id, status) VALUES (?, 'open') ON CONFLICT(id) DO NOTHING`, [periodId]);
}

/** Statements that persist a balanced journal batch (batch header + its lines). */
export function journalStatements(db: D1Database, batch: JournalBatch, periodId: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [
    stmt(db, `INSERT INTO finance_journal_batch (id, origin, source_type, source_id, currency, posting_date, period_id, reverses) VALUES (?,?,?,?,?,?,?,?)`,
      [batch.id, batch.origin, batch.source.type, batch.source.id, batch.currency, batch.postingDate, periodId, batch.reverses ?? null]),
  ];
  for (const l of batch.lines) {
    out.push(stmt(db, `INSERT INTO finance_journal_line (id, batch_id, account_code, debit_minor, credit_minor, cost_centre, memo) VALUES (?,?,?,?,?,?,?)`,
      [uuidv7(), batch.id, l.accountCode, l.debit.minor, l.credit.minor, l.costCentre ?? null, l.memo ?? null]));
  }
  return out;
}
