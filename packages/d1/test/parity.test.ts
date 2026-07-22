/**
 * The PWA parity handlers on D1 (Patients, Queue, Calendar, Command centre) —
 * the endpoints behind the five screens an operator clicks through. Runs on real
 * SQLite via node:sqlite (same engine as Cloudflare D1), against the actual
 * migrations including the synthetic demo seed.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { listPatients, registerPatient, startVisit, queueBoard, createSlot, calendarView, dashboard } from '../src/index.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations, applyD1Seeds } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await applyD1Seeds(db); // the synthetic demo data (production gets it via wrangler)
});

test('the demo seed makes every screen non-empty', async () => {
  assert.equal((await listPatients(db)).length, 3);
  assert.equal((await queueBoard(db)).length, 1);
  const cal = await calendarView(db, { from: '2026-07-22', to: '2026-07-22' });
  assert.equal(cal.length, 3);
});

test('patient search filters on name/MRN; short terms list all', async () => {
  assert.equal((await listPatients(db, 'ach')).length, 1); // "Achebe"
  assert.equal((await listPatients(db, 'SCC-000002')).length, 1);
  assert.equal((await listPatients(db, 'a')).length, 3); // <2 chars → list
});

test('registration issues a running MRN and is searchable', async () => {
  const res = await registerPatient(db, { givenName: 'Nia', familyName: 'Zulu', dateOfBirth: '1990-01-01' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mrn, 'SCC-000004'); // after the three seeded SCC-00000{1,2,3}
    assert.equal((await listPatients(db, 'Zulu')).length, 1);
  }
});

test('registration flags a likely duplicate and needs force', async () => {
  const dup = await registerPatient(db, { givenName: 'Ada', familyName: 'Achebe', dateOfBirth: '1984-03-11' });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.ok(dup.duplicates.length >= 1);
  const forced = await registerPatient(db, { givenName: 'Ada', familyName: 'Achebe', dateOfBirth: '1984-03-11', force: true });
  assert.equal(forced.ok, true);
});

test('check-in opens a visit and issues the next queue token', async () => {
  const before = await queueBoard(db);
  const r = await startVisit(db, { patientId: 'demo-pat-3', station: 'reception' });
  assert.equal(r.token, 2); // seed used token 1
  const after = await queueBoard(db);
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((row) => row.visitId === r.visitId && row.patientMrn === 'SCC-000003'));
});

test('a created slot appears in its day window', async () => {
  const { slotId } = await createSlot(db, { provider: 'Dr Osei', startsAt: '2026-08-01T08:00:00Z', endsAt: '2026-08-01T08:15:00Z', room: 'Room 3', serviceCode: 'GP' });
  const entries = await calendarView(db, { from: '2026-08-01', to: '2026-08-01' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.slotId, slotId);
  assert.equal(entries[0]!.day, '2026-08-01');
  // A booked seeded slot carries the patient MRN via the appointment join.
  const booked = await calendarView(db, { from: '2026-07-22', to: '2026-07-22' });
  assert.ok(booked.some((e) => e.status === 'booked' && e.patientMrn === 'SCC-000002'));
});

test('dashboard leads with exceptions and derives KPIs from live tables', async () => {
  const d = await dashboard(db, '2026-07-22T00:00:00Z');
  const visits = d.kpis.find((k) => k.id === 'visits');
  const patients = d.kpis.find((k) => k.id === 'registered_patients');
  assert.equal(visits?.value, 1);
  assert.equal(patients?.value, 3);
  // Seed stock is positive → no stockout exception.
  assert.ok(!d.exceptions.some((e) => e.type === 'stock_alerts'));
});
