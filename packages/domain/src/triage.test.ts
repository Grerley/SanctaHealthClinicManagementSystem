import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDangerSigns, earlyWarningScore, DANGER_RULE_VERSION, EWS_RULE_VERSION, type DangerSign } from './triage.ts';

test('normal vitals raise no danger signs', () => {
  const signs = detectDangerSigns([
    { kind: 'spo2_pct', value: 98 },
    { kind: 'systolic_bp', value: 120 },
    { kind: 'respiratory_rate', value: 16 },
    { kind: 'pulse_bpm', value: 72 },
    { kind: 'temperature_c', value: 36.8 },
  ]);
  assert.equal(signs.length, 0);
});

test('critical vitals produce emergency escalations, most severe first (TRI-005)', () => {
  const signs = detectDangerSigns([
    { kind: 'spo2_pct', value: 85 },
    { kind: 'systolic_bp', value: 80 },
    { kind: 'temperature_c', value: 39.8 },
  ]);
  assert.ok(signs.some((s) => s.code === 'hypoxia_severe' && s.severity === 'emergency'));
  assert.ok(signs.some((s) => s.code === 'hypotension' && s.severity === 'emergency'));
  assert.equal(signs[0]!.severity, 'emergency'); // sorted
  // Safety: every output is an escalation, never a diagnosis.
  for (const s of signs) assert.equal(s.action, 'escalate');
});

test('danger signs never carry a diagnosis field (TRI-005 no autonomous diagnosis)', () => {
  const signs = detectDangerSigns([{ kind: 'glucose_mmol', value: 2.5 }]);
  const s = signs[0]! as DangerSign & Record<string, unknown>;
  assert.equal(s.code, 'hypoglycaemia');
  assert.equal('diagnosis' in s, false);
  assert.equal('condition' in s, false);
  assert.equal(DANGER_RULE_VERSION, 'danger-signs-1');
});

test('early-warning score is transparent: components + version (TRI-004)', () => {
  const ews = earlyWarningScore([
    { kind: 'spo2_pct', value: 93 }, // 2 (92–93)
    { kind: 'respiratory_rate', value: 26 }, // 3
    { kind: 'systolic_bp', value: 105 }, // 1
    { kind: 'pulse_bpm', value: 72 }, // 0 → not a component
    { kind: 'temperature_c', value: 36.8 }, // 0
  ]);
  assert.equal(ews.ruleVersion, EWS_RULE_VERSION);
  assert.equal(ews.score, 6);
  assert.equal(ews.band, 'high'); // a single param scoring 3 → high
  assert.ok(ews.components.every((c) => c.points > 0));
  assert.ok(ews.components.some((c) => c.param === 'respiratory_rate' && c.points === 3));
  assert.ok(!ews.components.some((c) => c.param === 'pulse_bpm')); // zero-point params omitted
});

test('a low total with no single high param bands as low/medium', () => {
  const low = earlyWarningScore([{ kind: 'systolic_bp', value: 108 }]); // 1
  assert.equal(low.score, 1);
  assert.equal(low.band, 'low');
  const med = earlyWarningScore([
    { kind: 'spo2_pct', value: 93 }, // 2
    { kind: 'respiratory_rate', value: 23 }, // 2
    { kind: 'systolic_bp', value: 105 }, // 1
  ]); // total 5, no single >=3
  assert.equal(med.score, 5);
  assert.equal(med.band, 'medium');
});
