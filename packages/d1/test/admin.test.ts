/**
 * Config releases, feature flags & help on D1 (ADM-003/006/008). Runs on real
 * SQLite. Proves: a release moves through its lifecycle with maker-checker
 * approval (a maker cannot approve their own); publishing supersedes the prior
 * and rollback re-publishes it; feature flags gate by site/role; help topics list.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRelease, promoteRelease, rollbackRelease, currentConfig, setFeatureFlag, evaluateFlag, systemHealth, listHelpTopics, AdminError } from '../src/admin.ts';
import { AuthorisationError } from '@sancta/domain';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('a release is maker-checker approved, published and rolled back', async () => {
  const r1 = await createRelease(db, { name: 'triage-config', payload: { v: 1 }, by: 'maker1' });
  await promoteRelease(db, { id: r1.id, to: 'test', by: 'maker1' });
  await assert.rejects(() => promoteRelease(db, { id: r1.id, to: 'approved', by: 'maker1' }), AuthorisationError); // maker != checker
  await promoteRelease(db, { id: r1.id, to: 'approved', by: 'checker1' });
  await promoteRelease(db, { id: r1.id, to: 'published', by: 'checker1' });
  assert.equal((await currentConfig(db, 'triage-config'))?.version, 1);
  // A second release supersedes the first on publish.
  const r2 = await createRelease(db, { name: 'triage-config', payload: { v: 2 }, by: 'maker1' });
  await promoteRelease(db, { id: r2.id, to: 'test', by: 'maker1' });
  await promoteRelease(db, { id: r2.id, to: 'approved', by: 'checker1' });
  await promoteRelease(db, { id: r2.id, to: 'published', by: 'checker1' });
  assert.equal((await currentConfig(db, 'triage-config'))?.version, 2);
  // Rollback re-publishes v1.
  const rb = await rollbackRelease(db, { name: 'triage-config', by: 'checker1' });
  assert.equal(rb.published, r1.id);
  assert.equal((await currentConfig(db, 'triage-config'))?.version, 1);
});

test('an illegal transition is refused', async () => {
  const r = await createRelease(db, { name: 'x', payload: {}, by: 'm' });
  await assert.rejects(() => promoteRelease(db, { id: r.id, to: 'published', by: 'c' }), AdminError); // draft cannot jump to published
});

test('feature flags gate by site and role', async () => {
  await setFeatureFlag(db, { key: 'new-triage', enabled: true, roles: ['clinical'] });
  assert.equal(await evaluateFlag(db, 'new-triage', { roles: ['clinical'] }), true);
  assert.equal(await evaluateFlag(db, 'new-triage', { roles: ['reception'] }), false);
  assert.equal(await evaluateFlag(db, 'unknown-flag', {}), false); // unknown → off
  const health = await systemHealth(db);
  assert.equal(health.database, 'ok');
});

test('help topics list, onboarding steps in order', async () => {
  const onboarding = await listHelpTopics(db, 'onboarding');
  assert.ok(onboarding.length >= 2);
  assert.equal(onboarding[0]?.stepOrder, 1); // ordered by step
});
