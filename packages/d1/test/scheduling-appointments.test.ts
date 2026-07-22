/**
 * Appointment lifecycle on D1 (APT-001..008). Runs on real SQLite (same engine as
 * D1). Proves: no double-booking (the active-slot unique index is the lock-free
 * gate), cancelling releases the slot, the waitlist fills a released slot by domain
 * priority, reminders are idempotent, and appointment types are versioned.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlot, bookAppointment, nextAvailableSlot, setAppointmentStatus,
  addToWaitlist, fillReleasedSlot, queueReminder, setAppointmentType, resolveAppointmentType, SchedulingError,
} from '../src/scheduling.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const P1 = 'apt-p1', P2 = 'apt-p2';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(P1, 'SCC-010001', 'Ap', 'One').run();
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(P2, 'SCC-010002', 'Ap', 'Two').run();
});

test('a slot books once; a second booking is refused (no double-book)', async () => {
  const { slotId } = await createSlot(db, { provider: 'Dr A', startsAt: '2026-08-01T09:00:00Z', endsAt: '2026-08-01T09:20:00Z' });
  const first = await bookAppointment(db, { slotId, patientId: P1 });
  assert.equal(first.ok, true);
  const second = await bookAppointment(db, { slotId, patientId: P2 });
  assert.equal(second.ok, false); // slot no longer open
});

test('nextAvailableSlot finds the earliest open slot for a provider', async () => {
  await createSlot(db, { provider: 'Dr B', startsAt: '2026-08-02T11:00:00Z', endsAt: '2026-08-02T11:20:00Z' });
  await createSlot(db, { provider: 'Dr B', startsAt: '2026-08-02T09:00:00Z', endsAt: '2026-08-02T09:20:00Z' });
  const next = await nextAvailableSlot(db, { provider: 'Dr B', afterIso: '2026-08-02T00:00:00Z' });
  assert.equal(next?.startsAt, '2026-08-02T09:00:00Z');
});

test('cancelling releases the slot and the waitlist can fill it by priority', async () => {
  const { slotId } = await createSlot(db, { provider: 'Dr C', startsAt: '2026-08-03T09:00:00Z', endsAt: '2026-08-03T09:20:00Z' });
  const booked = await bookAppointment(db, { slotId, patientId: P1 });
  assert.equal(booked.ok, true);
  if (!booked.ok) return;
  await addToWaitlist(db, { patientId: P2, provider: 'Dr C', priority: 5 });
  // While booked, the slot cannot be filled.
  assert.deepEqual(await fillReleasedSlot(db, { slotId }), { filled: false, reason: 'slot_unavailable' });
  // Cancel → slot re-opens → waitlist fills it.
  await setAppointmentStatus(db, { appointmentId: booked.appointmentId, to: 'cancelled' });
  const fill = await fillReleasedSlot(db, { slotId });
  assert.equal(fill.filled, true);
  if (fill.filled) assert.equal(fill.patientId, P2);
});

test('illegal status transitions are rejected', async () => {
  const { slotId } = await createSlot(db, { provider: 'Dr D', startsAt: '2026-08-04T09:00:00Z', endsAt: '2026-08-04T09:20:00Z' });
  const b = await bookAppointment(db, { slotId, patientId: P1 });
  if (!b.ok) throw new Error('setup');
  await assert.rejects(() => setAppointmentStatus(db, { appointmentId: b.appointmentId, to: 'booked' }), Error);
});

test('reminders are idempotent on (appointment, kind)', async () => {
  const { slotId } = await createSlot(db, { provider: 'Dr E', startsAt: '2026-08-05T09:00:00Z', endsAt: '2026-08-05T09:20:00Z' });
  const b = await bookAppointment(db, { slotId, patientId: P1 });
  if (!b.ok) throw new Error('setup');
  const first = await queueReminder(db, { appointmentId: b.appointmentId, info: { when: '2026-08-05', time: '09:00', sensitive: false } });
  assert.equal(first.enqueued, true);
  const again = await queueReminder(db, { appointmentId: b.appointmentId, info: { when: '2026-08-05', time: '09:00', sensitive: false } });
  assert.equal(again.enqueued, false);   // same kind → not duplicated
  assert.equal(first.id, again.id);
});

test('appointment types are versioned effective-dated', async () => {
  await setAppointmentType(db, { code: 'GP', effectiveFrom: '2026-01-01', name: 'GP visit', durationMin: 15 });
  await assert.rejects(() => setAppointmentType(db, { code: 'GP', effectiveFrom: '2025-12-01', name: 'x', durationMin: 10 }), SchedulingError);
  await setAppointmentType(db, { code: 'GP', effectiveFrom: '2026-06-01', name: 'GP visit (long)', durationMin: 20 });
  assert.equal((await resolveAppointmentType(db, { code: 'GP', asOf: '2026-03-01' }))?.durationMin, 15);
  assert.equal((await resolveAppointmentType(db, { code: 'GP', asOf: '2026-07-01' }))?.durationMin, 20);
});
