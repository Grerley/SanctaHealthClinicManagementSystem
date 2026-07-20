import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDemographics, assertDemographics, DemographicError, type DemographicPolicy } from './demographics.ts';

const POLICY: DemographicPolicy = {
  fields: [
    { field: 'given_name', required: true },
    { field: 'family_name', required: true },
    { field: 'date_of_birth', required: true, allowUnknown: true },
    { field: 'sex', required: false },
    { field: 'phone', required: false, allowDeclined: true },
  ],
};

test('a complete submission passes', () => {
  const r = validateDemographics(POLICY, {
    given_name: { value: 'Amina' },
    family_name: { value: 'Okoro' },
    date_of_birth: { value: '1990-05-01' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 0);
});

test('a missing mandatory field is flagged', () => {
  const r = validateDemographics(POLICY, { given_name: { value: 'Amina' } });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === 'family_name'));
  assert.ok(r.issues.some((i) => i.field === 'date_of_birth'));
});

test('a mandatory field may be satisfied by a permitted marker', () => {
  const r = validateDemographics(POLICY, {
    given_name: { value: 'Amina' },
    family_name: { value: 'Okoro' },
    date_of_birth: { marker: 'unknown' }, // allowed
  });
  assert.equal(r.ok, true);
});

test('a marker not permitted for the field is rejected', () => {
  const r = validateDemographics(POLICY, {
    given_name: { value: 'Amina' },
    family_name: { marker: 'unknown' }, // family_name does not allow unknown
    date_of_birth: { value: '1990-05-01' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === 'family_name' && /unknown is not permitted/.test(i.reason)));
});

test('declined is permitted only where configured', () => {
  assert.equal(validateDemographics(POLICY, { given_name: { value: 'A' }, family_name: { value: 'B' }, date_of_birth: { value: 'x' }, phone: { marker: 'declined' } }).ok, true);
  const r = validateDemographics(POLICY, { given_name: { value: 'A' }, family_name: { value: 'B' }, date_of_birth: { marker: 'declined' } });
  assert.equal(r.ok, false); // date_of_birth allows unknown, not declined
});

test('a field cannot carry both a value and a marker', () => {
  const r = validateDemographics(POLICY, { given_name: { value: 'A' }, family_name: { value: 'B' }, date_of_birth: { value: '1990', marker: 'unknown' } });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /both a value and/.test(i.reason)));
});

test('optional empty fields are fine; whitespace does not count as a value', () => {
  assert.equal(validateDemographics(POLICY, { given_name: { value: 'A' }, family_name: { value: 'B' }, date_of_birth: { value: 'x' }, sex: { value: '' } }).ok, true);
  assert.equal(validateDemographics(POLICY, { given_name: { value: '  ' }, family_name: { value: 'B' }, date_of_birth: { value: 'x' } }).ok, false);
});

test('assertDemographics throws on failure', () => {
  assert.throws(() => assertDemographics(POLICY, { given_name: { value: 'A' } }), DemographicError);
  assert.doesNotThrow(() => assertDemographics(POLICY, { given_name: { value: 'A' }, family_name: { value: 'B' }, date_of_birth: { marker: 'unknown' } }));
});
