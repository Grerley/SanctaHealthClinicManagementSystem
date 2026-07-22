/**
 * Structured clinical forms on D1 (EHR-003). Runs on real SQLite. Proves: a new
 * form version closes the prior; the resolver returns the version in force on a
 * date; and listForms returns the currently-effective active forms.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { defineForm, formAsOf, listForms, FormAdminError } from '../src/forms.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const FIELDS = [{ key: 'complaint', label: 'Chief complaint', type: 'text', required: true }];

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a new form version closes the prior and resolves by date', async () => {
  const v1 = await defineForm(db, { formCode: 'SOAP', title: 'SOAP v1', fields: FIELDS, effectiveFrom: '2026-01-01', by: 'admin1' });
  assert.equal(v1.version, 1);
  const v2 = await defineForm(db, { formCode: 'SOAP', title: 'SOAP v2', fields: FIELDS, effectiveFrom: '2026-07-01', by: 'admin1' });
  assert.equal(v2.version, 2);
  assert.equal((await formAsOf(db, 'SOAP', '2026-03-01')).version, 1);
  assert.equal((await formAsOf(db, 'SOAP', '2026-08-01')).version, 2);
  await assert.rejects(() => defineForm(db, { formCode: 'SOAP', title: 'bad', fields: FIELDS, effectiveFrom: '2026-06-01' }), FormAdminError); // backdated
  await assert.rejects(() => defineForm(db, { formCode: 'X', title: 'no fields', fields: [], effectiveFrom: '2026-01-01' }), FormAdminError);
});

test('listForms returns the currently-effective forms', async () => {
  await defineForm(db, { formCode: 'SOAP', title: 'SOAP', fields: FIELDS, effectiveFrom: '2026-01-01' });
  await defineForm(db, { formCode: 'TRIAGE', title: 'Triage', fields: FIELDS, effectiveFrom: '2026-01-01' });
  const forms = await listForms(db, '2026-07-15');
  assert.equal(forms.length, 2);
  assert.ok(forms.every((f) => f.active));
});
