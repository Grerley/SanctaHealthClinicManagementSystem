/**
 * Effective-dated pricing & priced service charges on D1 (BIL-001, BIL-003,
 * BR-005). The price of a service is resolved from the fee schedule by effective
 * date; an override away from standard needs a reason, and one outside the min/max
 * band needs an approver (BIL-003, enforced by the domain `applyPrice`). Charging a
 * service creates a finalised invoice + line that RETAINS the applied rule version,
 * standard/applied amounts, adjustment and tax — so a later price change never
 * rewrites a historical invoice. The finalisation journal debits AR by applied+tax,
 * credits revenue by applied, and credits a tax liability by the tax split.
 * Ported from the Postgres edge `pricing.ts`.
 *
 * D1 translations: interactive tx → db.batch() (invoice + line + journal + audit
 * post atomically); the fee schedule read + override validation happen before the
 * write; period-open is asserted before posting (BR-010).
 */
import { uuidv7, money, resolveFee, applyPrice, assertPostable, type FeeVersion, type AppliedPrice, type JournalBatch } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';
import { ensurePeriod, journalStatements } from './journal.ts';
import { assertPeriodOpen } from './finance.ts';

export class PricingError extends Error {}

const AR = '1200-PATIENT-AR';
const SERVICE_REVENUE = '4000-SERVICE-REVENUE';
const TAX_PAYABLE = '2300-TAX-PAYABLE';

function today(): string { return new Date().toISOString().slice(0, 10); }

async function loadSchedule(db: D1Database, serviceCode: string): Promise<FeeVersion[]> {
  const rows = await many<{ service_code: string; version: number; effective_from: string; effective_to: string | null; standard_minor: number; min_minor: number; max_minor: number; tax_rate_bps: number | null; currency: string }>(
    db,
    `SELECT service_code, version, effective_from, effective_to, standard_minor, min_minor, max_minor, tax_rate_bps, currency
     FROM billing_fee_version WHERE service_code=? ORDER BY version`,
    [serviceCode],
  );
  return rows.map((x) => ({
    serviceCode: x.service_code,
    version: Number(x.version),
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
    standardMinor: Number(x.standard_minor),
    minMinor: Number(x.min_minor),
    maxMinor: Number(x.max_minor),
    ...(x.tax_rate_bps == null ? {} : { taxRateBps: Number(x.tax_rate_bps) }),
    currency: x.currency,
  }));
}

export type Quote = AppliedPrice & { onDate: string };

/**
 * Quote a price for a service on a date (no side effects). Resolves the effective
 * fee version and applies override rules (BIL-003). Throws if no fee is effective
 * or the override is not permitted.
 */
export async function quotePrice(
  db: D1Database,
  args: { serviceCode: string; onDate: string; appliedMinor?: number; reason?: string; approver?: string },
): Promise<Quote> {
  const schedule = await loadSchedule(db, args.serviceCode);
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
 * (Dr AR / Cr Revenue [/ Cr Tax payable]) atomically. Records any override
 * reason/approver on the line. Audited.
 */
export async function chargeService(
  db: D1Database,
  args: { patientId: string; serviceCode: string; onDate?: string; appliedMinor?: number; reason?: string; approver?: string; user?: string; period?: string },
): Promise<ServiceCharge> {
  const onDate = args.onDate ?? today();
  const schedule = await loadSchedule(db, args.serviceCode);
  const fee = resolveFee(schedule, args.serviceCode, onDate);
  const applied = applyPrice(fee, {
    ...(args.appliedMinor === undefined ? {} : { appliedMinor: args.appliedMinor }),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(args.approver === undefined ? {} : { approver: args.approver }),
  });

  const period = args.period ?? onDate.slice(0, 7);
  await ensurePeriod(db, period);
  await assertPeriodOpen(db, period);

  const invoiceId = uuidv7();
  const journal = finalisationBatch(invoiceId, onDate, applied.applied.minor, applied.tax.minor, fee.currency);
  await db.batch([
    stmt(db, `INSERT INTO billing_invoice (id, invoice_number, patient_id, status, currency, finalised_at) VALUES (?,?,?, 'finalised', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      [invoiceId, 'INV-' + invoiceId.slice(-12), args.patientId, fee.currency]),
    stmt(db, `INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, adjustment_minor, tax_minor, reason, approver) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv7(), invoiceId, args.serviceCode, applied.ruleVersion, applied.standard.minor, applied.applied.minor, applied.adjustment.minor, applied.tax.minor, applied.reason ?? null, applied.approver ?? null]),
    ...journalStatements(db, journal, period),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'create','invoice',?,'success',?,?)`,
      [uuidv7(), args.user ?? null, invoiceId, `charged ${args.serviceCode} v${applied.ruleVersion} = ${applied.total.minor}${applied.reason ? ' (override: ' + applied.reason + ')' : ''}`, 'charge:' + invoiceId]),
  ]);
  return { invoiceId, quote: { ...applied, onDate }, totalMinor: applied.total.minor };
}

// --- Fee schedule administration (BIL-001, governed reference data) --------

/** Define the next effective-dated fee version for a service, closing the prior. */
export async function defineFee(
  db: D1Database,
  args: { serviceCode: string; effectiveFrom: string; standardMinor: number; minMinor: number; maxMinor: number; taxRateBps?: number; currency?: string; by?: string },
): Promise<{ serviceCode: string; version: number }> {
  if (args.minMinor > args.standardMinor || args.standardMinor > args.maxMinor) {
    throw new PricingError('require min <= standard <= max');
  }
  const currency = args.currency ?? 'USD';
  const latest = await one<{ version: number; ef: string }>(db, `SELECT version, effective_from AS ef FROM billing_fee_version WHERE service_code=? ORDER BY version DESC LIMIT 1`, [args.serviceCode]);
  if (latest && args.effectiveFrom <= latest.ef) throw new PricingError(`new effective date must be after the current version's (${latest.ef})`);
  const next = latest ? Number(latest.version) + 1 : 1;

  const batch = [];
  if (latest) {
    batch.push(stmt(db, `UPDATE billing_fee_version SET effective_to=? WHERE service_code=? AND version=?`, [args.effectiveFrom, args.serviceCode, latest.version]));
  }
  batch.push(stmt(db, `INSERT INTO billing_fee_version (service_code, version, effective_from, standard_minor, min_minor, max_minor, tax_rate_bps, currency) VALUES (?,?,?,?,?,?,?,?)`,
    [args.serviceCode, next, args.effectiveFrom, args.standardMinor, args.minMinor, args.maxMinor, args.taxRateBps ?? null, currency]));
  batch.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','fee_version',?,'success',?,?)`,
    [uuidv7(), args.by ?? null, uuidv7(), `[${args.serviceCode}] v${next} standard ${args.standardMinor} from ${args.effectiveFrom}`, 'fee:' + args.serviceCode + ':' + next]));
  await db.batch(batch);
  return { serviceCode: args.serviceCode, version: next };
}

export async function listFees(db: D1Database, serviceCode?: string): Promise<FeeVersion[]> {
  if (serviceCode) return loadSchedule(db, serviceCode);
  const codes = await many<{ service_code: string }>(db, `SELECT DISTINCT service_code FROM billing_fee_version ORDER BY service_code`);
  const all: FeeVersion[] = [];
  for (const row of codes) all.push(...(await loadSchedule(db, row.service_code)));
  return all;
}
