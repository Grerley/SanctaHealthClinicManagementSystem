/**
 * Appointment waiting list, reminder de-duplication & versioned types
 * (APT-004, APT-005, APT-007) against real PostgreSQL. Proves: a released slot is
 * filled by the highest-priority compatible waiting entry; a reminder queues
 * exactly once even when the create is replayed (offline idempotency) and never
 * discloses a sensitive reason; and appointment types version forward.
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
import { createSlot, bookAppointment, setAppointmentStatus, addToWaitlist, fillReleasedSlot, queueReminder, setAppointmentType, resolveAppointmentType, SchedulingError } from '../src/scheduling.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PROVIDER = '00000000-0000-7000-8000-0000000000d1';
let PATIENT_LOW: string;
let PATIENT_HIGH: string;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    const r = await c.query(`SELECT id FROM identity.patient ORDER BY id LIMIT 2`);
    PATIENT_LOW = r.rows[0].id;
    PATIENT_HIGH = r.rows[1].id;
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('a released slot is filled by the highest-priority waiting entry (APT-004)', { skip }, async () => {
  const { slotId } = await createSlot(pool, { provider: PROVIDER, startsAt: '2026-08-01T09:00:00Z', endsAt: '2026-08-01T09:15:00Z' });
  const booked = await bookAppointment(pool, { slotId, patientId: PATIENT_LOW });
  assert.ok(booked.ok);

  // Two patients waiting: low priority (added first), high priority (added later).
  await addToWaitlist(pool, { patientId: PATIENT_LOW, provider: PROVIDER, priority: 1 });
  await addToWaitlist(pool, { patientId: PATIENT_HIGH, provider: PROVIDER, priority: 9 });

  // The booked patient cancels → slot re-opens.
  if (booked.ok) await setAppointmentStatus(pool, { appointmentId: booked.appointmentId, to: 'cancelled' });

  const fill = await fillReleasedSlot(pool, { slotId });
  assert.ok(fill.filled);
  if (fill.filled) assert.equal(fill.patientId, PATIENT_HIGH); // highest priority wins

  // The slot is booked again and the winning waitlist entry is marked filled.
  const slot = await pool.query(`SELECT status FROM scheduling.slot WHERE id=$1`, [slotId]);
  assert.equal(slot.rows[0].status, 'booked');
  const wl = await pool.query(`SELECT count(*)::int AS n FROM scheduling.waitlist WHERE status='filled'`);
  assert.equal(wl.rows[0].n, 1);

  // Filling an already-booked slot is a no-op.
  const again = await fillReleasedSlot(pool, { slotId });
  assert.equal(again.filled, false);
});

test('a reminder queues exactly once and never discloses a sensitive reason (APT-005, APT-009)', { skip }, async () => {
  const { slotId } = await createSlot(pool, { provider: PROVIDER, startsAt: '2026-08-02T09:00:00Z', endsAt: '2026-08-02T09:15:00Z' });
  const booked = await bookAppointment(pool, { slotId, patientId: PATIENT_LOW });
  assert.ok(booked.ok);
  const appointmentId = booked.ok ? booked.appointmentId : '';

  const info = { when: '2026-08-02', time: '09:00', location: 'Main clinic', reason: 'HIV clinic', sensitive: true } as const;
  const first = await queueReminder(pool, { appointmentId, kind: 'reminder-24h', info });
  assert.equal(first.enqueued, true);

  // Replay of the same offline-created reminder → not duplicated.
  const replay = await queueReminder(pool, { appointmentId, kind: 'reminder-24h', info });
  assert.equal(replay.enqueued, false);
  assert.equal(replay.id, first.id);

  const rows = await pool.query(`SELECT body FROM scheduling.reminder WHERE appointment_id=$1 AND kind='reminder-24h'`, [appointmentId]);
  assert.equal(rows.rowCount, 1); // exactly one
  assert.ok(!rows.rows[0].body.toLowerCase().includes('hiv')); // sensitive reason withheld
});

test('appointment types version forward with effective dating (APT-007)', { skip }, async () => {
  const v1 = await setAppointmentType(pool, { code: 'GP', effectiveFrom: '2026-01-01', name: 'GP consult', durationMin: 15, prep: 'None', depositMinor: 0 });
  assert.equal(v1.version, 1);
  const v2 = await setAppointmentType(pool, { code: 'GP', effectiveFrom: '2026-07-01', name: 'GP consult', durationMin: 20, depositMinor: 500 });
  assert.equal(v2.version, 2);
  await assert.rejects(setAppointmentType(pool, { code: 'GP', effectiveFrom: '2026-03-01', name: 'x', durationMin: 10 }), SchedulingError);

  // Resolve as-of picks the version whose window covers the date.
  const early = await resolveAppointmentType(pool, { code: 'GP', asOf: '2026-03-15' });
  assert.equal(early?.durationMin, 15);
  const late = await resolveAppointmentType(pool, { code: 'GP', asOf: '2026-07-15' });
  assert.equal(late?.durationMin, 20);
  assert.equal(late?.depositMinor, 500);

  // Unknown/too-early → null.
  assert.equal(await resolveAppointmentType(pool, { code: 'GP', asOf: '2025-12-01' }), null);
});
