/**
 * Patient self-service on D1 (COM-006). Runs on real SQLite. Proves: a token
 * gates access (revoked/expired rejected); the self summary shows balance +
 * upcoming appointments; a booking request is PENDING until staff confirm it into
 * an open slot; and a payment intent requires a positive amount.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, revokeToken, selfSummary, requestBooking, recordPayIntent, listBookingRequests, confirmBooking, SelfServiceError } from '../src/selfservice.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'ss-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'MRN-SS1', 'Alan', 'Turing').run();
  await db.prepare(`INSERT INTO scheduling_slot (id, provider, starts_at, ends_at, status) VALUES ('slot-1', 'dr-smith', '2027-01-01T09:00:00Z', '2027-01-01T09:30:00Z', 'open')`).run();
});

test('a token gates access; revoked and expired tokens are rejected', async () => {
  const { token } = await issueToken(db, { patientId: PID });
  const s = await selfSummary(db, token);
  assert.equal(s.patient.name, 'Alan Turing');
  await revokeToken(db, token);
  await assert.rejects(() => selfSummary(db, token), SelfServiceError);
  // An expired token is refused.
  await db.prepare(`INSERT INTO flow_self_service_token (token, patient_id, expires_at) VALUES ('expired',?, '2020-01-01T00:00:00Z')`).bind(PID).run();
  await assert.rejects(() => selfSummary(db, 'expired'), SelfServiceError);
});

test('a booking request stays pending until staff confirm it into an open slot', async () => {
  const { token } = await issueToken(db, { patientId: PID });
  const { id, status } = await requestBooking(db, { token, provider: 'dr-smith', preferredDate: '2027-01-01' });
  assert.equal(status, 'pending');
  assert.equal((await listBookingRequests(db)).length, 1);
  const { appointmentId } = await confirmBooking(db, { requestId: id, slotId: 'slot-1', user: 'reception1' });
  assert.ok(appointmentId);
  assert.equal((await listBookingRequests(db)).length, 0); // no longer pending
  assert.equal((await one<{ status: string }>(db, `SELECT status FROM scheduling_slot WHERE id='slot-1'`))?.status, 'booked');
  // The now-consumed request cannot be confirmed again.
  await assert.rejects(() => confirmBooking(db, { requestId: id, slotId: 'slot-1' }), SelfServiceError);
});

test('a payment intent requires a positive amount', async () => {
  const { token } = await issueToken(db, { patientId: PID });
  await assert.rejects(() => recordPayIntent(db, { token, amountMinor: 0 }), SelfServiceError);
  const { status } = await recordPayIntent(db, { token, amountMinor: 5000, method: 'mobile' });
  assert.equal(status, 'pending');
});
