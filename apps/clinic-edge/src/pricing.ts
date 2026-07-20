/**
 * Effective-dated pricing & priced service charges (BIL-001, BIL-003, BR-005,
 * pack §8.3).
 *
 * The price of a service is resolved from the fee schedule by its effective date;
 * an override away from standard needs a reason, and one outside the min/max band
 * needs an approver (BIL-003). Charging a service creates a finalised invoice that
 * RETAINS the applied rule version, standard and applied amounts, adjustment and
 * tax — so a later price change never rewrites a historical invoice. Tax is split
 * into a liability; the finalisation journal debits AR by applied+tax.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, money, resolveFee, applyPrice, assertPostable, type FeeVersion, type AppliedPrice, type JournalBatch } from '@sancta/domain';
import { insertJournalBatch } from './journal.ts';

export class PricingError extends Error {}

const AR = '1200-PATIENT-AR';
const SERVICE_REVENUE = '4000-SERVICE-REVENUE';
const TAX_PAYABLE = '2300-TAX-PAYABLE';

async function loadSchedule(client: PoolClient | Pool, serviceCode: string): Promise<FeeVersion[]> {
  const r = await client.query(
    `SELECT service_code, version, to_char(effective_from,'YYYY-MM-DD') AS effective_from,
            to_char(effective_to,'YYYY-MM-DD') AS effective_to, standard_minor, min_minor, max_minor, tax_rate_bps, currency
     FROM billing.fee_version WHERE service_code=$1 ORDER BY version`,
    [serviceCode],
  );
  return r.rows.map((x) => ({
    serviceCode: x.service_code,
    version: x.version,
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
    standardMinor: Number(x.standard_minor),
    minMinor: Number(x.min_minor),
    maxMinor: Number(x.max_minor),
    ...(x.tax_rate_bps == null ? {} : { taxRateBps: Number(x.tax_rate_bps) }),
    currency: x.currency,
  }));
}

export type Quote = AppliedPrice & { serviceCode: string; onDate: string };

/**
 * Quote a price for a service on a date (no side effects). Resolves the effective
 * fee version and applies override rules (BIL-003). Throws PricingError if no fee
 * is effective or the override is not permitted.
 */
export async function quotePrice(
  pool: Pool,
  args: { serviceCode: string; onDate: string; appliedMinor?: number; reason?: string; approver?: string },
): Promise<Quote> {
  const schedule = await loadSchedule(pool, args.serviceCode);
  const fee = resolveFee(schedule, args.serviceCode, args.onDate); // throws PriceError if none
  const applied = applyPrice(fee, {
    ...(args.appliedMinor === undefined ? {} : { appliedMinor: args.appliedMinor }),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(args.approver === undefined ? {} : { approver: args.approver }),
  });
  return { ...applied, onDate: args.onDate };
}

function finalisationBatch(invoiceId: string, postingDate: string, appliedMinor: number, taxMinor: number, currency: string): JournalBatch {
  const lines = [
    { accountCode: AR, debit: money(appliedMinor + taxMinor, currency), credit: money(0, currency), memo: 'invoice finalised' },
    { accountCode: SERVICE_REVENUE, debit: money(0, currency), credit: money(appliedMinor, currency), memo: 'service revenue' },
  ];
  if (taxMinor > 0) lines.push({ accountCode: TAX_PAYABLE, debit: money(0, currency), credit: money(taxMinor, currency), memo: 'tax payable' });
  const batch: JournalBatch = { id: uuidv7(), origin: 'system', source: { type: 'invoice', id: invoiceId }, currency, postingDate, lines };
  assertPostable(batch);
  return batch;
}

export type ServiceCharge = { invoiceId: string; quote: Quote; totalMinor: number };

/**
 * Charge a service to a patient: price it from the schedule, create a finalised
 * invoice + line retaining the applied pricing, and post the revenue journal
 * (Dr AR / Cr Revenue [/ Cr Tax payable]). Optionally records the price override
 * reason/approver on the line. Audited.
 */
export async function chargeService(
  pool: Pool,
  args: { patientId: string; serviceCode: string; onDate?: string; appliedMinor?: number; reason?: string; approver?: string; user?: string; period?: string },
): Promise<ServiceCharge> {
  const onDate = args.onDate ?? '2026-07-19';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schedule = await loadSchedule(client, args.serviceCode);
    const fee = resolveFee(schedule, args.serviceCode, onDate);
    const applied = applyPrice(fee, {
      ...(args.appliedMinor === undefined ? {} : { appliedMinor: args.appliedMinor }),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
      ...(args.approver === undefined ? {} : { approver: args.approver }),
    });

    const invoiceId = uuidv7();
    await client.query(
      `INSERT INTO billing.invoice (id, invoice_number, patient_id, status, currency, finalised_at)
       VALUES ($1,$2,$3,'finalised',$4, now())`,
      [invoiceId, 'INV-' + invoiceId.slice(-12), args.patientId, fee.currency],
    );
    await client.query(
      `INSERT INTO billing.invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, adjustment_minor, tax_minor, reason, approver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uuidv7(), invoiceId, args.serviceCode, applied.ruleVersion, applied.standard.minor, applied.applied.minor, applied.adjustment.minor, applied.tax.minor, applied.reason ?? null, applied.approver ?? null],
    );

    const period = args.period ?? onDate.slice(0, 7);
    await insertJournalBatch(client, finalisationBatch(invoiceId, onDate, applied.applied.minor, applied.tax.minor, fee.currency), period);

    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','invoice',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), args.user ?? null, invoiceId, args.patientId, `charged ${args.serviceCode} v${applied.ruleVersion} = ${applied.total.minor}${applied.reason ? ' (override: ' + applied.reason + ')' : ''}`, 'charge:' + invoiceId],
    );

    await client.query('COMMIT');
    return { invoiceId, quote: { ...applied, onDate }, totalMinor: applied.total.minor };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Fee schedule administration (BIL-001, governed reference data) --------

/** Define the next effective-dated fee version for a service, closing the prior. */
export async function defineFee(
  pool: Pool,
  args: { serviceCode: string; effectiveFrom: string; standardMinor: number; minMinor: number; maxMinor: number; taxRateBps?: number; currency?: string; by?: string },
): Promise<{ serviceCode: string; version: number }> {
  if (args.minMinor > args.standardMinor || args.standardMinor > args.maxMinor) {
    throw new PricingError('require min <= standard <= max');
  }
  const currency = args.currency ?? 'USD';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT version, to_char(effective_from,'YYYY-MM-DD') AS ef FROM billing.fee_version WHERE service_code=$1 ORDER BY version DESC LIMIT 1`, [args.serviceCode]);
    const latest = cur.rows[0];
    if (latest && args.effectiveFrom <= latest.ef) throw new PricingError(`new effective date must be after the current version's (${latest.ef})`);
    const next = latest ? latest.version + 1 : 1;
    if (latest) {
      await client.query(`UPDATE billing.fee_version SET effective_to=$3 WHERE service_code=$1 AND version=$2`, [args.serviceCode, latest.version, args.effectiveFrom]);
    }
    await client.query(
      `INSERT INTO billing.fee_version (service_code, version, effective_from, standard_minor, min_minor, max_minor, tax_rate_bps, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [args.serviceCode, next, args.effectiveFrom, args.standardMinor, args.minMinor, args.maxMinor, args.taxRateBps ?? null, currency],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','fee_version',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, uuidv7(), `[${args.serviceCode}] v${next} standard ${args.standardMinor} from ${args.effectiveFrom}`, 'fee:' + args.serviceCode + ':' + next],
    );
    await client.query('COMMIT');
    return { serviceCode: args.serviceCode, version: next };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listFees(pool: Pool, serviceCode?: string): Promise<FeeVersion[]> {
  if (serviceCode) return loadSchedule(pool, serviceCode);
  const r = await pool.query(`SELECT DISTINCT service_code FROM billing.fee_version ORDER BY service_code`);
  const all: FeeVersion[] = [];
  for (const row of r.rows) all.push(...(await loadSchedule(pool, row.service_code)));
  return all;
}
