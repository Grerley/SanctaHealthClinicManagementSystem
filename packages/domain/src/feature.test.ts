import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureEnabled, type FeatureFlag } from './feature.ts';

const base: FeatureFlag = { key: 'new_dashboard', enabled: true, sites: [], roles: [] };

test('a disabled flag is always off', () => {
  assert.equal(featureEnabled({ ...base, enabled: false }, { site: 'A', roles: ['manager'] }), false);
});

test('no restrictions → on for everyone (ADM-006)', () => {
  assert.equal(featureEnabled(base, {}), true);
  assert.equal(featureEnabled(base, { site: 'A', roles: ['clinical'] }), true);
});

test('site restriction gates by site (ADM-006)', () => {
  const f = { ...base, sites: ['A'] };
  assert.equal(featureEnabled(f, { site: 'A' }), true);
  assert.equal(featureEnabled(f, { site: 'B' }), false);
  assert.equal(featureEnabled(f, {}), false); // no site → not in the allowed set
});

test('role restriction gates by role (ADM-006)', () => {
  const f = { ...base, roles: ['manager', 'administrator'] };
  assert.equal(featureEnabled(f, { roles: ['manager'] }), true);
  assert.equal(featureEnabled(f, { roles: ['clinical'] }), false);
  assert.equal(featureEnabled(f, {}), false);
});

test('site AND role must both pass when both restricted', () => {
  const f = { ...base, sites: ['A'], roles: ['manager'] };
  assert.equal(featureEnabled(f, { site: 'A', roles: ['manager'] }), true);
  assert.equal(featureEnabled(f, { site: 'A', roles: ['clinical'] }), false);
  assert.equal(featureEnabled(f, { site: 'B', roles: ['manager'] }), false);
});
