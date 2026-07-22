/**
 * Audit search & audited export on D1 (ADM-004). Runs on real SQLite. Proves:
 * search filters by user/resource/date and orders newest-first; and exporting
 * audit data records the export itself as an audit event.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchAudit, exportAudit } from '../src/audit.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import { one } from '../src/query.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, captured_at) VALUES ('e1','dr1','sign','encounter','enc1','success','2026-07-10T09:00:00Z')`).run();
  await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, captured_at) VALUES ('e2','cashier1','receive_payment','payment','pay1','success','2026-07-11T09:00:00Z')`).run();
});

test('search filters and orders newest-first', async () => {
  const all = await searchAudit(db, {});
  assert.equal(all.length, 2);
  assert.equal(all[0]?.id, 'e2'); // newest first
  const byUser = await searchAudit(db, { user: 'dr1' });
  assert.equal(byUser.length, 1);
  assert.equal(byUser[0]?.resourceType, 'encounter');
  const byDate = await searchAudit(db, { fromIso: '2026-07-11T00:00:00Z' });
  assert.equal(byDate.length, 1);
  assert.equal(byDate[0]?.id, 'e2');
});

test('exporting audit data records the export itself as an audit event', async () => {
  const { rows, exportEventId } = await exportAudit(db, { resourceType: 'encounter' }, 'auditor1');
  assert.equal(rows.length, 1);
  const ev = await one<{ action: string; actor_user: string }>(db, `SELECT action, actor_user FROM audit_event WHERE id=?`, [exportEventId]);
  assert.equal(ev?.action, 'export');
  assert.equal(ev?.actor_user, 'auditor1');
  // The export event is itself now discoverable.
  assert.equal((await searchAudit(db, { action: 'export' })).length, 1);
});
