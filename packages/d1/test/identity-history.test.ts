/**
 * Patient identity history & deceased provenance on D1 (PAT-007). Runs on real
 * SQLite. Proves: a demographic change keeps the previous value with provenance
 * and bumps the entity version; an unknown field is rejected; and death is
 * recorded once with date + recorder.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { changeDemographic, markDeceased, patientIdentityHistory, IdentityHistoryError } from '../src/identity-history.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'idh-p1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name) VALUES (?,?,?,?)`).bind(PID, 'MRN-IDH1', 'Robert', 'Stone').run();
});

test('a demographic change preserves provenance and bumps the entity version', async () => {
  const res = await changeDemographic(db, { patientId: PID, field: 'family_name', newValue: 'Stone-Rivers', reason: 'marriage', by: 'reception1' });
  assert.equal(res.oldValue, 'Stone');
  assert.equal(res.newValue, 'Stone-Rivers');
  const p = await one<{ family_name: string; entity_version: number }>(db, `SELECT family_name, entity_version FROM identity_patient WHERE id=?`, [PID]);
  assert.equal(p?.family_name, 'Stone-Rivers');
  assert.equal(p?.entity_version, 2);
  const hist = await patientIdentityHistory(db, PID);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]?.reason, 'marriage');
  await assert.rejects(() => changeDemographic(db, { patientId: PID, field: 'ssn' as never, newValue: 'x' }), IdentityHistoryError);
});

test('death is recorded once with date and recorder', async () => {
  const r = await markDeceased(db, { patientId: PID, deceasedAt: '2026-07-15', reason: 'reported by family', by: 'nurse1' });
  assert.equal(r.deceasedAt, '2026-07-15');
  const p = await one<{ deceased: number; deceased_at: string; deceased_recorded_by: string }>(db, `SELECT deceased, deceased_at, deceased_recorded_by FROM identity_patient WHERE id=?`, [PID]);
  assert.equal(p?.deceased, 1);
  assert.equal(p?.deceased_at, '2026-07-15');
  assert.equal(p?.deceased_recorded_by, 'nurse1');
  // Re-recording is refused.
  await assert.rejects(() => markDeceased(db, { patientId: PID, deceasedAt: '2026-07-16' }), IdentityHistoryError);
  assert.ok((await patientIdentityHistory(db, PID)).some((h) => h.field === 'deceased'));
});
