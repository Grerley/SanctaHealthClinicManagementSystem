import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageBand, publicQueueEntry, analyticalRecord } from './deidentify.ts';

test('age band generalises DOB and never exposes the exact date (MGT-009)', () => {
  assert.equal(ageBand('2024-01-01', '2026-07-21'), '0-4');
  assert.equal(ageBand('2010-07-21', '2026-07-21'), '15-24'); // exactly 16
  assert.equal(ageBand('1990-04-20', '2026-07-21'), '35-44');
  assert.equal(ageBand('1950-01-01', '2026-07-21'), '65+');
  // Birthday not yet reached this year → still the younger band.
  assert.equal(ageBand('1991-12-31', '2026-07-21'), '25-34'); // turns 35 in December
});

test('a public queue entry exposes only token/station/status/wait (VIS-009)', () => {
  const e = publicQueueEntry({ token: 'A12', station: 'Triage', status: 'waiting', waitMinutes: 15 });
  assert.deepEqual(Object.keys(e).sort(), ['station', 'status', 'token', 'waitMinutes']);
  // No identity field can be present — the projection simply has no such keys.
  assert.ok(!('patientId' in e));
  assert.ok(!('name' in e));
});

test('an analytical record drops identifiers and keeps only safe fields (MGT-009)', () => {
  const r = analyticalRecord({ pseudoId: 'p-abc123', dob: '1990-04-20', sex: 'F', siteId: 'site-1', asOf: '2026-07-21' });
  assert.deepEqual(r, { pseudoId: 'p-abc123', ageBand: '35-44', sex: 'F', siteId: 'site-1' });
  // The exact DOB must not survive the projection.
  assert.ok(!JSON.stringify(r).includes('1990-04-20'));
  // Missing sex defaults to 'unknown', not blank/leaked.
  assert.equal(analyticalRecord({ pseudoId: 'x', dob: '2000-01-01', sex: null, siteId: null, asOf: '2026-07-21' }).sex, 'unknown');
});
