/**
 * Facility operations on D1 (OPS-002/004/005/006). Runs on real SQLite. Proves:
 * resources carry capacity/status and available capacity sums correctly; a
 * checklist run is flagged incomplete when a required item is missing; an incident
 * cannot close without a corrective action; and due maintenance surfaces.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addResource, setResourceStatus, availableCapacity, defineChecklist, runChecklist, reportIncident, updateIncident, openIncidents, scheduleMaintenance, completeMaintenance, dueMaintenance, FacilityError } from '../src/facility.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('resources carry capacity/status and available capacity sums correctly', async () => {
  const a = await addResource(db, { kind: 'room', name: 'Consult 1', capacity: 1 });
  await addResource(db, { kind: 'room', name: 'Consult 2', capacity: 2 });
  assert.equal((await availableCapacity(db, 'room')).availableCapacity, 3);
  await setResourceStatus(db, { id: a.id, status: 'maintenance' });
  assert.equal((await availableCapacity(db, 'room')).availableCapacity, 2); // one room out
  await assert.rejects(() => addResource(db, { kind: 'spaceship', name: 'X' }), FacilityError);
});

test('a checklist run is flagged incomplete when a required item is missing', async () => {
  await defineChecklist(db, { code: 'OPEN', name: 'Morning open', kind: 'room', items: [{ key: 'fridge_temp', label: 'Fridge temp logged', required: true }, { key: 'notes', label: 'Notes' }] });
  const partial = await runChecklist(db, { templateCode: 'OPEN', results: { notes: 'ok' }, performedBy: 'nurse1' });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['fridge_temp']);
  const full = await runChecklist(db, { templateCode: 'OPEN', results: { fridge_temp: '4C' }, performedBy: 'nurse1' });
  assert.equal(full.complete, true);
  await assert.rejects(() => runChecklist(db, { templateCode: 'NOPE', results: {} }), FacilityError);
});

test('an incident cannot close without a corrective action', async () => {
  const { id } = await reportIncident(db, { kind: 'near_miss', severity: 'high', description: 'wrong label nearly used', reportedBy: 'nurse1' });
  assert.equal((await openIncidents(db)).length, 1);
  await assert.rejects(() => updateIncident(db, { id, status: 'closed' }), FacilityError);
  await updateIncident(db, { id, status: 'closed', correctiveAction: 'relabelled + retrained', by: 'mgr1' });
  assert.equal((await openIncidents(db)).length, 0);
});

test('due maintenance surfaces until completed', async () => {
  const r = await addResource(db, { kind: 'equipment', name: 'Centrifuge', capacity: 1 });
  const m = await scheduleMaintenance(db, { resourceId: r.id, kind: 'calibration', dueDate: '2026-07-01' });
  assert.equal((await dueMaintenance(db, '2026-07-20')).length, 1);
  await completeMaintenance(db, { id: m.id, performedBy: 'tech1' });
  assert.equal((await dueMaintenance(db, '2026-07-20')).length, 0);
  await assert.rejects(() => completeMaintenance(db, { id: m.id }), FacilityError); // already done
  await assert.rejects(() => scheduleMaintenance(db, { resourceId: 'ghost', kind: 'calibration', dueDate: '2026-07-01' }), FacilityError);
});
