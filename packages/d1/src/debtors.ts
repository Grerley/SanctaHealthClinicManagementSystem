/**
 * Debtor ageing + collection work queue on D1 (BIL-008, §9). Outstanding is
 * DERIVED from the immutable invoice-line and payment-allocation records (never a
 * stored balance), aged by as-of date, and reconciled to the patient AR control
 * account from the journals. If they disagree, the exception is surfaced — a
 * report can never quietly diverge from the ledger (§10.1). Ported from the
 * Postgres edge `debtors.ts`. No new tables.
 *
 * D1 translations: to_char(...) → stored ISO text sliced to a date; aggregate
 * subqueries unchanged; per-patient rollup in JS.
 */
import { ageDebtors, ageingTotal, bandFor, type OpenItem, type AgeingBand } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many } from './query.ts';

export type DebtorRow = { patientId: string; mrn: string | null; name: string; outstandingMinor: number; oldestBand: AgeingBand };
export type AgeingReport = {
  asOf: string;
  buckets: Record<AgeingBand, number>;
  totalMinor: number;
  arControlMinor: number;
  reconciles: boolean;
  workQueue: DebtorRow[];
};

const BANDS: AgeingBand[] = ['0-30', '31-60', '61-90', '90+'];
function bandRank(b: AgeingBand): number { return BANDS.indexOf(b); }

/** Outstanding per finalised invoice = lines (applied + tax) - allocations. */
async function openItems(db: D1Database): Promise<Array<OpenItem & { patientId: string }>> {
  const rows = await many<{ invoice_id: string; patient_id: string; due_date: string; outstanding: number }>(db,
    `SELECT i.id AS invoice_id, i.patient_id,
            substr(COALESCE(i.finalised_at, i.created_at),1,10) AS due_date,
            ( (SELECT COALESCE(SUM(applied_minor+tax_minor),0) FROM billing_invoice_line l WHERE l.invoice_id=i.id)
            - (SELECT COALESCE(SUM(amount_minor),0) FROM billing_payment_allocation a WHERE a.invoice_id=i.id) ) AS outstanding
     FROM billing_invoice i
     WHERE i.status IN ('finalised','part_paid','paid')`);
  return rows.map((r) => ({ invoiceId: r.invoice_id, dueDate: r.due_date, outstandingMinor: Number(r.outstanding), currency: 'USD', patientId: r.patient_id }));
}

/** Patient AR control-account balance from the journals (debit-positive). */
async function arControlMinor(db: D1Database): Promise<number> {
  const r = await one<{ bal: number }>(db, `SELECT COALESCE(SUM(debit_minor)-SUM(credit_minor),0) AS bal FROM finance_journal_line WHERE account_code='1200-PATIENT-AR'`);
  return Number(r?.bal ?? 0);
}

export async function ageingReport(db: D1Database, asOf: string): Promise<AgeingReport> {
  const items = await openItems(db);
  const buckets = ageDebtors(items, asOf);
  const totalMinor = ageingTotal(buckets).minor;
  const arControl = await arControlMinor(db);

  const byPatient = new Map<string, { outstanding: number; oldest: AgeingBand }>();
  for (const it of items) {
    if (it.outstandingMinor <= 0) continue;
    const band = bandFor(it.dueDate, asOf);
    const cur = byPatient.get(it.patientId) ?? { outstanding: 0, oldest: '0-30' as AgeingBand };
    cur.outstanding += it.outstandingMinor;
    if (bandRank(band) > bandRank(cur.oldest)) cur.oldest = band;
    byPatient.set(it.patientId, cur);
  }

  const workQueue: DebtorRow[] = [];
  for (const [patientId, agg] of byPatient) {
    const row = await one<{ mrn: string | null; given_name: string | null; family_name: string | null }>(db, `SELECT mrn, given_name, family_name FROM identity_patient WHERE id=?`, [patientId]);
    workQueue.push({
      patientId,
      mrn: row?.mrn ?? null,
      name: row ? `${row.family_name ?? ''}, ${row.given_name ?? ''}` : 'Unknown',
      outstandingMinor: agg.outstanding,
      oldestBand: agg.oldest,
    });
  }
  workQueue.sort((a, b) => bandRank(b.oldestBand) - bandRank(a.oldestBand) || b.outstandingMinor - a.outstandingMinor);

  return {
    asOf,
    buckets: { '0-30': buckets['0-30'].minor, '31-60': buckets['31-60'].minor, '61-90': buckets['61-90'].minor, '90+': buckets['90+'].minor },
    totalMinor,
    arControlMinor: arControl,
    reconciles: totalMinor === arControl,
    workQueue,
  };
}
