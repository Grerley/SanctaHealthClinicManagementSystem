/**
 * Patient self-service (COM-006, future) against real PostgreSQL. Proves: a scoped
 * token gates access (invalid/revoked/expired rejected); the summary shows the
 * patient's own balance and appointments; a booking request is staff-confirmed
 * (never auto-booked); and a payment intent is recorded pending reconciliation.
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
import { doCheckout } from '../src/api.ts';
import { createSlot } from '../src/scheduling.ts';
import { issueToken, revokeToken, selfSummary, requestBooking, recordPayIntent, listBookingRequests, confirmBooking, SelfServiceError } from '../src/selfservice.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const PROVIDER = '00000000-0000-7000-8000-0000000000d1';
let TOKEN: string;

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
  await doCheckout(pool, { patientId: PATIENT, sku: 'AMOX-500', quantity: 10, chargeMinor: 1500, paymentMinor: 500, paymentMethod: 'cash' });
  TOKEN = (await issueToken(pool, { patientId: PATIENT, ttlHours: 24 })).token;
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('a scoped token gates self-service access (COM-006)', { skip }, async () => {
  const summary = await selfSummary(pool, TOKEN);
  assert.equal(summary.accountBalanceMinor, 1000); // 1500 charged − 500 paid
  assert.ok(summary.patient.name.length > 0);

  // Bad, revoked and expired tokens are all rejected.
  await assert.rejects(selfSummary(pool, 'not-a-token'), SelfServiceError);
  const revocable = (await issueToken(pool, { patientId: PATIENT })).token;
  await revokeToken(pool, revocable);
  await assert.rejects(selfSummary(pool, revocable), /revoked/);
  await pool.query(`UPDATE flow.self_service_token SET expires_at = now() - interval '1 hour' WHERE token=$1`, [TOKEN]);
  await assert.rejects(selfSummary(pool, TOKEN), /expired/);
  // Re-issue a valid token for the rest of the suite.
  TOKEN = (await issueToken(pool, { patientId: PATIENT })).token;
});

test('a booking request is staff-confirmed, never auto-booked (COM-006)', { skip }, async () => {
  const req = await requestBooking(pool, { token: TOKEN, provider: PROVIDER, serviceCode: 'GP', preferredDate: '2026-09-01', note: 'morning if possible' });
  assert.equal(req.status, 'pending');

  // No appointment exists yet — it is only a request.
  const before2 = await pool.query(`SELECT count(*)::int AS n FROM scheduling.appointment WHERE patient_id=$1`, [PATIENT]);
  assert.equal(before2.rows[0].n, 0);

  // Staff see the request and confirm it into an open slot.
  const pending = await listBookingRequests(pool);
  assert.ok(pending.some((r) => r.id === req.id));
  const { slotId } = await createSlot(pool, { provider: PROVIDER, startsAt: '2026-09-01T09:00:00Z', endsAt: '2026-09-01T09:30:00Z' });
  const confirmed = await confirmBooking(pool, { requestId: req.id, slotId, user: '00000000-0000-7000-8000-0000000000b1' });
  assert.ok(confirmed.appointmentId);

  // Now the appointment exists and the request is confirmed (off the pending list).
  const after = await pool.query(`SELECT status, appointment_id FROM flow.booking_request WHERE id=$1`, [req.id]);
  assert.equal(after.rows[0].status, 'confirmed');
  assert.equal(after.rows[0].appointment_id, confirmed.appointmentId);
  assert.ok(!(await listBookingRequests(pool)).some((r) => r.id === req.id));

  // Confirming again is rejected.
  await assert.rejects(confirmBooking(pool, { requestId: req.id, slotId }), SelfServiceError);
});

test('a payment intent is recorded pending reconciliation (COM-006)', { skip }, async () => {
  const intent = await recordPayIntent(pool, { token: TOKEN, amountMinor: 1000, method: 'mobile', note: 'paying my balance' });
  assert.equal(intent.status, 'pending');
  const row = await pool.query(`SELECT amount_minor, status FROM flow.payment_intent WHERE id=$1`, [intent.id]);
  assert.equal(Number(row.rows[0].amount_minor), 1000);
  assert.equal(row.rows[0].status, 'pending');

  // A non-positive amount and a bad token are rejected.
  await assert.rejects(recordPayIntent(pool, { token: TOKEN, amountMinor: 0 }), SelfServiceError);
  await assert.rejects(recordPayIntent(pool, { token: 'bad', amountMinor: 100 }), SelfServiceError);
});
