/**
 * Debtor ageing + collection work queue (BIL-008, pack §9). Outstanding is
 * derived from the immutable invoice-line and payment-allocation records (never a
 * stored balance), aged by as-of date, and reconciled to the patient AR control
 * account from the journals. If they disagree, the exception is surfaced — a
 * report can never quietly diverge from the ledger (pack §10.1).
 */
import type { Pool } from 'pg';
import { ageDebtors, ageingTotal, bandFor, type OpenItem, type AgeingBand } from '@sancta/domain';

export type DebtorRow = {
  patientId: string;
  mrn: string | null;
  name: string;
  outstandingMinor: number;
  oldestBand: AgeingBand;
};

export type AgeingReport = {
  asOf: string;
  buckets: Record<AgeingBand, number>;
  totalMinor: number;
  arControlMinor: number;
  reconciles: boolean;
  workQueue: DebtorRow[];
};

const BANDS: AgeingBand[] = ['0-30', '31-60', '61-90', '90+'];

function bandRank(b: AgeingBand): number {
  return BANDS.indexOf(b);
}

/** Outstanding per finalised invoice = lines (applied + tax) - allocations. */
async function openItems(pool: Pool): Promise<Array<OpenItem & { patientId: string }>> {
  const res = await pool.query(
    `SELECT i.id AS invoice_id, i.patient_id,
            to_char(coalesce(i.finalised_at, i.created_at),'YYYY-MM-DD') AS due_date,
            ( (SELECT coalesce(sum(applied_minor+tax_minor),0) FROM billing.invoice_line l WHERE l.invoice_id=i.id)
            - (SELECT coalesce(sum(amount_minor),0) FROM billing.payment_allocation a WHERE a.invoice_id=i.id)
            )::bigint AS outstanding
     FROM billing.invoice i
     WHERE i.status IN ('finalised','part_paid','paid')`,
  );
  return res.rows.map((r) => ({
    invoiceId: r.invoice_id,
    dueDate: r.due_date,
    outstandingMinor: Number(r.outstanding),
    currency: 'USD',
    patientId: r.patient_id,
  }));
}

/** Patient AR control-account balance from the journals (debit-positive). */
async function arControlMinor(pool: Pool): Promise<number> {
  const r = await pool.query(
    `SELECT coalesce(sum(debit_minor)-sum(credit_minor),0)::bigint AS bal FROM finance.journal_line WHERE account_code='1200-PATIENT-AR'`,
  );
  return Number(r.rows[0].bal);
}

export async function ageingReport(pool: Pool, asOf: string): Promise<AgeingReport> {
  const items = await openItems(pool);
  const buckets = ageDebtors(items, asOf);
  const totalMinor = ageingTotal(buckets).minor;
  const arControl = await arControlMinor(pool);

  // Build the per-patient work queue (outstanding > 0), oldest band first.
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
    const p = await pool.query(`SELECT mrn, given_name, family_name FROM identity.patient WHERE id=$1`, [patientId]);
    const row = p.rows[0];
    workQueue.push({
      patientId,
      mrn: row?.mrn ?? null,
      name: row ? `${row.family_name}, ${row.given_name}` : 'Unknown',
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
