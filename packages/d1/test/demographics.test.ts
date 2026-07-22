/**
 * Demographic capture policy on D1 (PAT-004). Runs on real SQLite. Proves: the
 * seeded default policy loads with the right required/marker rules; a field rule
 * can be revised (upsert) and a new field created; and the loaded policy drives
 * the domain validator.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, listPolicy, setFieldRule, DemographicPolicyError } from '../src/demographics.ts';
import { validateDemographics } from '@sancta/domain';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('the seeded default policy loads with required/marker rules', async () => {
  const policy = await loadPolicy(db);
  const givenName = policy.fields.find((f) => f.field === 'given_name');
  assert.equal(givenName?.required, true);
  const dob = policy.fields.find((f) => f.field === 'date_of_birth');
  assert.equal(dob?.required, true);
  assert.equal(dob?.allowUnknown, true);
});

test('a field rule can be revised and a new field created (upsert)', async () => {
  await setFieldRule(db, { field: 'phone', required: true, allowDeclined: true, displayOrder: 50, by: 'admin1' });
  const phone = (await listPolicy(db)).find((f) => f.field === 'phone');
  assert.equal(phone?.required, true);
  await setFieldRule(db, { field: 'next_of_kin', required: false, allowUnknown: true, by: 'admin1' });
  assert.ok((await listPolicy(db)).some((f) => f.field === 'next_of_kin'));
  await assert.rejects(() => setFieldRule(db, { field: '  ', required: true }), DemographicPolicyError);
});

test('the loaded policy drives the domain validator', async () => {
  const policy = await loadPolicy(db);
  // Missing required given_name → an issue; supplying it (and other required) → ok.
  const bad = validateDemographics(policy, { family_name: { value: 'Doe' }, date_of_birth: { value: '1990-01-01' }, sex: { value: 'f' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.field === 'given_name'));
  const good = validateDemographics(policy, { given_name: { value: 'Jane' }, family_name: { value: 'Doe' }, date_of_birth: { value: '1990-01-01' }, sex: { value: 'f' } });
  assert.equal(good.ok, true);
});
