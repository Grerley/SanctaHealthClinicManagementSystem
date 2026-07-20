/**
 * Encounter-to-charge completeness + day-close exception (BIL-002/012, BR-004,
 * UAT-07) against real PostgreSQL. Proves: a signed billable encounter with no
 * charge outcome is a gap surfaced at day close; linking a charge resolves it; an
 * authorised waiver (with reason + approver) also resolves it; completeness reaches
 * 100% only when every billable completed encounter has an outcome.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { createDraftEncounter, signEncounter } from '../src/encounters.ts';
import { recordPayment } from '../src/billing.ts';
import { markBillable, linkCharge, authoriseException, chargeCaptureReport, ChargeError } from '../src/billing-completeness.ts';
import { dashboard } from '../src/management.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const DOCTOR = '00000000-0000-7000-8000-0000000000e1';
const FINANCE = '00000000-0000-7000-8000-0000000000ad';

async function billableSigned(): Promise<string> {
  const { encounterId } = await createDraftEncounter(pool, { patientId: PATIENT });
  await markBillable(pool, encounterId);
  await signEncounter(pool, { encounterId, signedBy: DOCTOR, content: { service: 'consult' } });
  return encounterId;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('a signed billable encounter with no charge is a day-close gap (UAT-07)', { skip }, async () => {
  const enc = await billableSigned();
  const report = await chargeCaptureReport(pool);
  assert.equal(report.billableCompleted, 1);
  assert.equal(report.charged, 0);
  assert.ok(report.gaps.some((g) => g.encounterId === enc));
  assert.equal(report.completenessPct, 0);

  // It also surfaces as a management exception (leads with exceptions).
  const dash = await dashboard(pool, '2026-07-19');
  assert.ok(dash.exceptions.some((e) => e.type === 'unbilled_encounters' && e.count >= 1));
});

test('linking a charge resolves the gap (BIL-002)', { skip }, async () => {
  const enc = await billableSigned();
  // Create a finalised invoice to charge against.
  const inv = await pool.query(
    `INSERT INTO billing.invoice (id, invoice_number, patient_id, status, currency, finalised_at)
     VALUES (gen_random_uuid()::uuid, 'INV-CAP1', $1, 'finalised', 'USD', now()) RETURNING id`,
    [PATIENT],
  );
  await linkCharge(pool, { encounterId: enc, invoiceId: inv.rows[0].id });
  const report = await chargeCaptureReport(pool);
  assert.ok(!report.gaps.some((g) => g.encounterId === enc));
  assert.ok(report.charged >= 1);
});

test('an authorised waiver resolves the gap with a reason + approver (BR-004)', { skip }, async () => {
  const enc = await billableSigned();
  await assert.rejects(authoriseException(pool, { encounterId: enc, outcome: 'waived', reason: '', approver: FINANCE }), ChargeError);
  await authoriseException(pool, { encounterId: enc, outcome: 'waived', reason: 'hardship, approved', approver: FINANCE });
  const report = await chargeCaptureReport(pool);
  assert.ok(!report.gaps.some((g) => g.encounterId === enc));
  assert.ok(report.authorisedExceptions >= 1);

  // The waiver is audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='charge_exception' AND resource_id=$1`, [enc]);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('completeness reaches 100% only when every billable encounter has an outcome', { skip }, async () => {
  // Reset to a clean slate for a precise ratio.
  await pool.query(`UPDATE clinical.encounter SET billable=false`);
  const a = await billableSigned();
  const b = await billableSigned();
  let report = await chargeCaptureReport(pool);
  assert.equal(report.billableCompleted, 2);
  assert.equal(report.completenessPct, 0);

  const { paymentId } = await recordPayment(pool, { patientId: PATIENT, method: 'cash', amountMinor: 100 });
  assert.ok(paymentId);
  const inv = await pool.query(`INSERT INTO billing.invoice (id, invoice_number, patient_id, status, currency, finalised_at) VALUES (gen_random_uuid()::uuid,'INV-CAP2',$1,'finalised','USD',now()) RETURNING id`, [PATIENT]);
  await linkCharge(pool, { encounterId: a, invoiceId: inv.rows[0].id });
  report = await chargeCaptureReport(pool);
  assert.equal(report.completenessPct, 50);

  await authoriseException(pool, { encounterId: b, outcome: 'non_billable', reason: 'follow-up within episode', approver: FINANCE });
  report = await chargeCaptureReport(pool);
  assert.equal(report.completenessPct, 100);
  assert.equal(report.gaps.length, 0);
});
