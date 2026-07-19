/**
 * Appointment scheduling (APT-001/002/003/006) against real PostgreSQL. Proves:
 * slots can be booked; a slot cannot be double-booked (concurrent attempts);
 * next-available-slot search skips the booked one; cancelling releases the slot;
 * and illegal status transitions are rejected.
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
import { TransitionError } from '@sancta/domain';
import { createSlot, bookAppointment, nextAvailableSlot, setAppointmentStatus } from '../src/scheduling.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PROVIDER = '00000000-0000-7000-8000-0000000000e1';
const PATIENT = '00000000-0000-7000-8000-000000000101';
const PATIENT2 = '00000000-0000-7000-8000-000000000102';

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

test('a slot can be created and booked (APT-002)', { skip }, async () => {
  const { slotId } = await createSlot(pool, { provider: PROVIDER, startsAt: '2026-08-01T09:00:00Z', endsAt: '2026-08-01T09:15:00Z' });
  const res = await bookAppointment(pool, { slotId, patientId: PATIENT, serviceCode: 'CONSULT-GP' });
  assert.ok(res.ok);
});

test('a slot cannot be double-booked, even concurrently (APT-001)', { skip }, async () => {
  const { slotId } = await createSlot(pool, { provider: PROVIDER, startsAt: '2026-08-01T09:30:00Z', endsAt: '2026-08-01T09:45:00Z' });
  const [a, b] = await Promise.all([
    bookAppointment(pool, { slotId, patientId: PATIENT }),
    bookAppointment(pool, { slotId, patientId: PATIENT2 }),
  ]);
  const booked = [a, b].filter((r) => r.ok).length;
  const rejected = [a, b].filter((r) => !r.ok).length;
  assert.equal(booked, 1, 'exactly one booking succeeds');
  assert.equal(rejected, 1, 'the other is rejected as unavailable');
});

test('next-available-slot skips booked slots (APT-003)', { skip }, async () => {
  // Fresh provider with two slots; book the earlier one.
  const provider = '00000000-0000-7000-8000-0000000000c1';
  const s1 = await createSlot(pool, { provider, startsAt: '2026-08-02T09:00:00Z', endsAt: '2026-08-02T09:15:00Z' });
  const s2 = await createSlot(pool, { provider, startsAt: '2026-08-02T10:00:00Z', endsAt: '2026-08-02T10:15:00Z' });
  await bookAppointment(pool, { slotId: s1.slotId, patientId: PATIENT });
  const next = await nextAvailableSlot(pool, { provider, afterIso: '2026-08-02T00:00:00Z' });
  assert.equal(next?.slotId, s2.slotId);
});

test('cancelling releases the slot back to open (APT-006)', { skip }, async () => {
  const provider = '00000000-0000-7000-8000-0000000000c2';
  const { slotId } = await createSlot(pool, { provider, startsAt: '2026-08-03T09:00:00Z', endsAt: '2026-08-03T09:15:00Z' });
  const booked = await bookAppointment(pool, { slotId, patientId: PATIENT });
  assert.ok(booked.ok);
  if (booked.ok) {
    await setAppointmentStatus(pool, { appointmentId: booked.appointmentId, to: 'cancelled' });
    const next = await nextAvailableSlot(pool, { provider, afterIso: '2026-08-03T00:00:00Z' });
    assert.equal(next?.slotId, slotId, 'slot is open again after cancellation');
  }
});

test('an illegal status transition is rejected (pack §13.1)', { skip }, async () => {
  const provider = '00000000-0000-7000-8000-0000000000c3';
  const { slotId } = await createSlot(pool, { provider, startsAt: '2026-08-04T09:00:00Z', endsAt: '2026-08-04T09:15:00Z' });
  const booked = await bookAppointment(pool, { slotId, patientId: PATIENT });
  assert.ok(booked.ok);
  if (booked.ok) {
    // booked -> completed is not allowed (must arrive/check-in/in-service first)
    await assert.rejects(setAppointmentStatus(pool, { appointmentId: booked.appointmentId, to: 'completed' }), TransitionError);
  }
});
