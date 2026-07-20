import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessSite, accessibleSites, isCentral } from './site.ts';

const SITE_A = 'aaaa';
const SITE_B = 'bbbb';

test('central roles see across every site (central oversight, OPS-008)', () => {
  assert.equal(isCentral(['manager']), true);
  assert.equal(canAccessSite(['manager'], SITE_A, SITE_B), true);
  assert.equal(canAccessSite(['administrator'], null, SITE_B), true);
  assert.deepEqual(accessibleSites(['auditor'], SITE_A, [SITE_A, SITE_B]), [SITE_A, SITE_B]);
});

test('local roles are scoped to their own site (OPS-008 authorisation matrix)', () => {
  assert.equal(isCentral(['clinical']), false);
  assert.equal(canAccessSite(['clinical'], SITE_A, SITE_A), true); // own site
  assert.equal(canAccessSite(['clinical'], SITE_A, SITE_B), false); // other site denied
  assert.equal(canAccessSite(['reception'], null, SITE_A), false); // no site → no cross-site access
  assert.deepEqual(accessibleSites(['cashier'], SITE_A, [SITE_A, SITE_B]), [SITE_A]);
  assert.deepEqual(accessibleSites(['cashier'], null, [SITE_A, SITE_B]), []);
});

test('network-scoped (unscoped) data is visible to any authenticated user', () => {
  assert.equal(canAccessSite(['clinical'], SITE_A, null), true);
  assert.equal(canAccessSite(['stock'], null, null), true);
});
