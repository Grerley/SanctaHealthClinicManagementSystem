import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFormContent, assertFormContent, resolveForm, FormError, type FormDefinition } from './forms.ts';

const HEAP: FormDefinition = {
  formCode: 'HEAP',
  version: 2,
  title: 'History/Examination/Assessment/Plan',
  effectiveFrom: '2026-07-01',
  fields: [
    { key: 'history', label: 'History', type: 'text', required: true },
    { key: 'temperature', label: 'Temp', type: 'number' },
    { key: 'pregnant', label: 'Pregnant', type: 'boolean' },
    { key: 'onset', label: 'Onset', type: 'date' },
    { key: 'severity', label: 'Severity', type: 'code', options: ['mild', 'moderate', 'severe'] },
  ],
};

const HEAP_V1: FormDefinition = { ...HEAP, version: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01', fields: [{ key: 'history', label: 'History', type: 'text', required: true }] };

test('valid content passes', () => {
  const r = validateFormContent(HEAP, { history: 'cough 3 days', temperature: 38.2, pregnant: false, onset: '2026-07-10', severity: 'moderate' });
  assert.equal(r.ok, true);
});

test('a missing required field is flagged', () => {
  const r = validateFormContent(HEAP, { temperature: 37 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.key === 'history'));
});

test('wrong types are flagged', () => {
  const r = validateFormContent(HEAP, { history: 'x', temperature: 'hot', pregnant: 'yes', onset: '10/07/2026' });
  assert.ok(r.issues.some((i) => i.key === 'temperature'));
  assert.ok(r.issues.some((i) => i.key === 'pregnant'));
  assert.ok(r.issues.some((i) => i.key === 'onset')); // not ISO
});

test('an invalid code is flagged; a valid one passes', () => {
  assert.equal(validateFormContent(HEAP, { history: 'x', severity: 'critical' }).ok, false);
  assert.equal(validateFormContent(HEAP, { history: 'x', severity: 'severe' }).ok, true);
});

test('content with a key that is not part of the form is flagged', () => {
  const r = validateFormContent(HEAP, { history: 'x', bogus: 1 });
  assert.ok(r.issues.some((i) => i.key === 'bogus' && /not a field/.test(i.reason)));
});

test('assertFormContent throws on failure', () => {
  assert.throws(() => assertFormContent(HEAP, {}), FormError);
  assert.doesNotThrow(() => assertFormContent(HEAP, { history: 'ok' }));
});

test('resolveForm picks the version in force on a date', () => {
  const defs = [HEAP, HEAP_V1];
  assert.equal(resolveForm(defs, 'HEAP', '2026-03-01').version, 1);
  assert.equal(resolveForm(defs, 'HEAP', '2026-08-01').version, 2);
  assert.throws(() => resolveForm(defs, 'HEAP', '2025-01-01'), FormError);
  // v1 required only history, so v2's extra fields are not enforced for a v1 encounter.
  assert.equal(validateFormContent(resolveForm(defs, 'HEAP', '2026-03-01'), { history: 'x' }).ok, true);
});
