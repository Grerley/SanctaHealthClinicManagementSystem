/**
 * Facility operations (OPS-002/004/005/006) against real PostgreSQL. Proves:
 * resources track capacity + status; a checklist run is complete only when every
 * required item is answered; an incident cannot close without a corrective action;
 * and maintenance/calibration becomes "due" and clears when performed.
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
import {
  addResource, setResourceStatus, listResources, availableCapacity,
  defineChecklist, runChecklist, reportIncident, updateIncident, openIncidents,
  scheduleMaintenance, completeMaintenance, dueMaintenance, FacilityError,
} from '../src/facility.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const MANAGER = '00000000-0000-7000-8000-0000000000c1';

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

test('resources track capacity and status; available capacity excludes maintenance (OPS-002)', { skip }, async () => {
  const a = await addResource(pool, { kind: 'room', name: 'Consult 1', capacity: 1 });
  await addResource(pool, { kind: 'room', name: 'Consult 2', capacity: 1 });
  await addResource(pool, { kind: 'service_point', name: 'Dressing bay', capacity: 2 });
  await assert.rejects(addResource(pool, { kind: 'spaceship', name: 'x' }), FacilityError);

  let cap = await availableCapacity(pool, 'room');
  assert.equal(cap.availableUnits, 2);
  assert.equal(cap.availableCapacity, 2);

  // Put one room into maintenance → capacity drops.
  await setResourceStatus(pool, { id: a.id, status: 'maintenance' });
  cap = await availableCapacity(pool, 'room');
  assert.equal(cap.availableUnits, 1);
  assert.ok((await listResources(pool, 'room')).some((r) => r.status === 'maintenance'));
});

test('a checklist run completes only when required items are answered (OPS-004)', { skip }, async () => {
  await defineChecklist(pool, {
    code: 'OPENING', name: 'Morning opening', kind: 'opening',
    items: [
      { key: 'fridge_temp_ok', label: 'Cold-chain fridge in range', required: true },
      { key: 'emergency_kit', label: 'Emergency kit checked', required: true },
      { key: 'notes_ok', label: 'Handover notes read', required: false },
    ],
  });
  const partial = await runChecklist(pool, { templateCode: 'OPENING', results: { fridge_temp_ok: true }, performedBy: MANAGER });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['emergency_kit']);

  const done = await runChecklist(pool, { templateCode: 'OPENING', results: { fridge_temp_ok: true, emergency_kit: true }, performedBy: MANAGER });
  assert.equal(done.complete, true);
  assert.equal(done.missing.length, 0);
  await assert.rejects(runChecklist(pool, { templateCode: 'NOPE', results: {} }), /unknown checklist/);
});

test('an incident cannot close without a corrective action (OPS-005)', { skip }, async () => {
  const inc = await reportIncident(pool, { kind: 'near_miss', severity: 'high', description: 'wrong lot nearly dispensed', reportedBy: MANAGER });
  assert.ok((await openIncidents(pool)).some((i) => i.id === inc.id && i.severity === 'high'));

  await updateIncident(pool, { id: inc.id, status: 'investigating', by: MANAGER });
  await assert.rejects(updateIncident(pool, { id: inc.id, status: 'closed', by: MANAGER }), /corrective action/);

  await updateIncident(pool, { id: inc.id, status: 'closed', correctiveAction: 'added a second-check step', by: MANAGER });
  assert.ok(!(await openIncidents(pool)).some((i) => i.id === inc.id));
  await assert.rejects(reportIncident(pool, { kind: 'nonsense', description: 'x' }), FacilityError);
});

test('maintenance becomes due and clears when performed (OPS-006)', { skip }, async () => {
  const eq = await addResource(pool, { kind: 'equipment', name: 'Autoclave', capacity: null as unknown as number });
  const m = await scheduleMaintenance(pool, { resourceId: eq.id, kind: 'calibration', dueDate: '2026-07-01' });
  await assert.rejects(scheduleMaintenance(pool, { resourceId: eq.id, kind: 'bogus', dueDate: '2026-07-01' }), FacilityError);

  let due = await dueMaintenance(pool, '2026-07-20');
  assert.ok(due.some((d) => d.id === m.id && d.kind === 'calibration'));

  await completeMaintenance(pool, { id: m.id, performedBy: MANAGER, notes: 'passed' });
  due = await dueMaintenance(pool, '2026-07-20');
  assert.ok(!due.some((d) => d.id === m.id));
  await assert.rejects(completeMaintenance(pool, { id: m.id }), /already completed/);
});
