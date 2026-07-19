import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVital, validateVitals, bmi, VitalError } from './vitals.ts';

test('a normal value flags ok', () => {
  const r = validateVital('temperature_c', 36.8);
  assert.equal(r.flag, 'ok');
  assert.equal(r.requiresConfirmation, false);
});

test('an out-of-reference but plausible value flags without forcing confirmation', () => {
  const r = validateVital('systolic_bp', 150); // above soft 140, below hard 300
  assert.equal(r.flag, 'out_of_reference');
  assert.equal(r.requiresConfirmation, false);
});

test('an implausible value flags for confirmation, never silent rejection (TRI-003, UAT-03)', () => {
  const r = validateVital('temperature_c', 350); // e.g. a mistyped/serialised value
  assert.equal(r.flag, 'implausible');
  assert.equal(r.requiresConfirmation, true);
  assert.match(r.message ?? '', /confirm or correct/);
});

test('a set with an implausible value cannot save without confirmation', () => {
  assert.throws(
    () => validateVitals([{ kind: 'pulse_bpm', value: 72 }, { kind: 'spo2_pct', value: 5 }]),
    VitalError,
  );
});

test('the same set saves once confirmed, and the data is preserved (not dropped)', () => {
  const results = validateVitals([{ kind: 'pulse_bpm', value: 72 }, { kind: 'spo2_pct', value: 5 }], { confirmed: true });
  assert.equal(results.length, 2);
  assert.equal(results[1]!.value, 5); // value retained
  assert.equal(results[1]!.flag, 'implausible');
});

test('rejects non-finite and unknown vitals', () => {
  assert.throws(() => validateVital('pulse_bpm', Number.NaN), VitalError);
});

test('bmi is computed from weight and height', () => {
  assert.equal(bmi(70, 175), 22.9);
  assert.throws(() => bmi(70, 0), VitalError);
});
