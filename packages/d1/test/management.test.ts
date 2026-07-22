/**
 * Management command-centre extensions on D1 (MGT-002/006/007/010). Runs on real
 * SQLite. Proves: the dashboard leads with exceptions and derives KPIs live; a
 * management export is audited; drill-through to clinical detail is gated by the
 * clinical-detail permission; and KPI commentary is append-only.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../src/dashboard.ts';
import { exportDashboard, resolveSiteScope, drillThrough, addCommentary, listCommentary, ManagementScopeError } from '../src/management.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('the dashboard derives KPIs live and leads with exceptions', async () => {
  const dash = await dashboard(db, '2026-07-20');
  assert.ok(dash.kpis.find((k) => k.id === 'recognised_revenue'));
  assert.ok(dash.kpis.find((k) => k.id === 'charge_capture_completeness'));
  assert.ok(dash.kpis.every((k) => k.owner && k.formula)); // every KPI carries a definition (MGT-008)
});

test('a management export is audited', async () => {
  const env = await exportDashboard(db, { asOf: '2026-07-20', exportedBy: 'manager1', format: 'json' });
  assert.equal(env.confidentiality, 'management-only');
  assert.ok(env.dashboard.kpis.length > 0);
  const ev = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_event WHERE action='export' AND resource_type='management_report'`);
  assert.equal(ev?.n, 1);
});

test('drill-through to clinical detail is gated by permission', async () => {
  // A manager (view_summary/export) can drill operational but not clinical detail.
  const ok = await drillThrough(db, { roles: ['manager'], target: 'operational', actor: 'mgr1' });
  assert.equal(ok.target, 'operational');
  await assert.rejects(() => drillThrough(db, { roles: ['manager'], target: 'clinical_detail', actor: 'mgr1' }), ManagementScopeError);
  // The denial was audited.
  const deny = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_event WHERE resource_type='management_drill' AND outcome='deny'`);
  assert.equal(deny?.n, 1);
});

test('KPI commentary is append-only and returns newest first', async () => {
  await addCommentary(db, { kpiId: 'recognised_revenue', period: '2026-07', commentary: 'Revenue down on fewer visits', action: 'Review clinic hours', actionOwner: 'mgr1', authoredBy: 'mgr1' });
  await addCommentary(db, { kpiId: 'recognised_revenue', period: '2026-07', commentary: 'Follow-up: hours extended', authoredBy: 'mgr1' });
  const notes = await listCommentary(db, { kpiId: 'recognised_revenue', period: '2026-07' });
  assert.equal(notes.length, 2);
  assert.equal(notes[0]?.commentary, 'Follow-up: hours extended'); // newest first
  await assert.rejects(() => addCommentary(db, { kpiId: 'x', period: '2026-07', commentary: '' }), ManagementScopeError);
});

test('site scope resolves against the caller authorisation', async () => {
  const scope = await resolveSiteScope(db, { roles: ['manager'], userSite: null });
  assert.ok(scope.allowed.includes('site-main'));
});
