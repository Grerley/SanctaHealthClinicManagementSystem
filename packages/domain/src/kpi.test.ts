import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKpiTarget, bandKpi, compareKpi, type KpiTarget } from './kpi.ts';

const TARGETS: KpiTarget[] = [
  { kpiId: 'charge_capture', version: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01', target: 100, warnAt: 90, critAt: 80, direction: 'higher_better' },
  { kpiId: 'charge_capture', version: 2, effectiveFrom: '2026-07-01', target: 100, warnAt: 95, critAt: 85, direction: 'higher_better' },
  { kpiId: 'wait_minutes', version: 1, effectiveFrom: '2026-01-01', target: 15, warnAt: 20, critAt: 40, direction: 'lower_better' },
];

test('resolveKpiTarget is effective-dated (MGT-004)', () => {
  assert.equal(resolveKpiTarget(TARGETS, 'charge_capture', '2026-03-01')!.version, 1);
  assert.equal(resolveKpiTarget(TARGETS, 'charge_capture', '2026-08-01')!.version, 2);
  assert.equal(resolveKpiTarget(TARGETS, 'unknown', '2026-08-01'), null);
});

test('higher-better banding: green/amber/red (MGT-004)', () => {
  const t = resolveKpiTarget(TARGETS, 'charge_capture', '2026-08-01'); // warn 95, crit 85
  assert.equal(bandKpi(98, t).colour, 'green');
  assert.equal(bandKpi(90, t).colour, 'amber');
  assert.equal(bandKpi(80, t).colour, 'red');
});

test('lower-better banding inverts (MGT-004)', () => {
  const t = resolveKpiTarget(TARGETS, 'wait_minutes', '2026-08-01'); // warn 20, crit 40, lower better
  assert.equal(bandKpi(12, t).status, 'on_target');
  assert.equal(bandKpi(30, t).status, 'warning');
  assert.equal(bandKpi(55, t).status, 'critical');
});

test('no thresholds → neutral band', () => {
  assert.equal(bandKpi(50, null).status, 'no_target');
  assert.equal(bandKpi(50, { kpiId: 'x', version: 1, effectiveFrom: '2026-01-01', direction: 'higher_better' }).colour, 'grey');
});

test('compareKpi computes delta + trend against the prior period (MGT-005)', () => {
  const t = resolveKpiTarget(TARGETS, 'charge_capture', '2026-08-01');
  const up = compareKpi('charge_capture', 96, 90, t);
  assert.equal(up.delta, 6);
  assert.equal(up.trend, 'up');
  assert.equal(up.band.colour, 'green');

  const first = compareKpi('charge_capture', 88, null, t);
  assert.equal(first.prior, null);
  assert.equal(first.delta, null);
  assert.equal(first.trend, 'flat');
  assert.equal(first.band.colour, 'amber');
});
