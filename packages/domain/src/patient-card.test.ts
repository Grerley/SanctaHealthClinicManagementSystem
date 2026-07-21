import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patientCardQr, resolvePatientCardQr } from './patient-card.ts';

const ID = '00000000-0000-7000-8000-000000000101';

test('the card QR encodes only an opaque reference — no PHI (PAT-006)', () => {
  const payload = patientCardQr(ID);
  assert.equal(payload, 'SANCTA:PT:' + ID);
  // Even given a name, the payload builder cannot include it — it only takes the id.
  assert.ok(!/mary|watson|1990/i.test(payload));
});

test('a scanned card resolves back to the patient id (PAT-006)', () => {
  assert.equal(resolvePatientCardQr(patientCardQr(ID)), ID);
  assert.equal(resolvePatientCardQr('SANCTA:PT:'), null); // empty id
  assert.equal(resolvePatientCardQr('OTHER:XYZ'), null); // not our scheme
  assert.equal(resolvePatientCardQr('random text'), null);
});
