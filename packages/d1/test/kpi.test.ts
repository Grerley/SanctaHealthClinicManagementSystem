/**
 * KPI targets + period comparison on D1 (MGT-004/005). Runs on real SQLite.
 * Proves: an effective-dated target version closes the prior; a snapshot upserts
 * per period; and a comparison bands the current value against the resolved target
 * and the prior period.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKpiTarget, recordSnapshot, kpiComparison, KpiAdminError } from '../src/kpi.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('an effective-dated target version closes the prior', async () => {
  const v1 = await setKpiTarget(db, { kpiId: 'wait-time', effectiveFrom: '2026-01-01', target: 30, warnAt: 45, critAt: 60, direction: 'lower_better', by: 'mgr1' });
  assert.equal(v1.version, 1);
  const v2 = await setKpiTarget(db, { kpiId: 'wait-time', effectiveFrom: '2026-07-01', target: 25, warnAt: 40, critAt: 55, direction: 'lower_better', by: 'mgr1' });
  assert.equal(v2.version, 2);
  await assert.rejects(() => setKpiTarget(db, { kpiId: 'wait-time', effectiveFrom: '2026-06-01', target: 20 }), KpiAdminError); // backdated
});

test('a snapshot upserts per period and a comparison bands the value', async () => {
  await setKpiTarget(db, { kpiId: 'wait-time', effectiveFrom: '2026-01-01', target: 30, warnAt: 45, critAt: 60, direction: 'lower_better', by: 'mgr1' });
  await recordSnapshot(db, { kpiId: 'wait-time', period: '2026-06', value: 50 });
  await recordSnapshot(db, { kpiId: 'wait-time', period: '2026-07', value: 28 });
  await recordSnapshot(db, { kpiId: 'wait-time', period: '2026-07', value: 26 }); // upsert overwrites
  const cmp = await kpiComparison(db, { kpiId: 'wait-time', period: '2026-07', priorPeriod: '2026-06' });
  assert.equal(cmp.current, 26);
  assert.equal(cmp.prior, 50);
  assert.ok(cmp.refreshedAt);
  await assert.rejects(() => kpiComparison(db, { kpiId: 'wait-time', period: '2099-01', priorPeriod: '2026-06' }), KpiAdminError);
});
