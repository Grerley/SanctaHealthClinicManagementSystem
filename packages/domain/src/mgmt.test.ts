import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSiteFilter, canDrill, drillPermission } from './mgmt.ts';

const A = 'site-a', B = 'site-b', ALL = ['site-a', 'site-b'];

test('a central role may filter any site; local users only their own (MGT-002)', () => {
  assert.deepEqual(effectiveSiteFilter(['manager'], A, [B], ALL), { allowed: [B], rejected: [] });
  const local = effectiveSiteFilter(['clinical'], A, [A, B], ALL);
  assert.deepEqual(local.allowed, [A]);
  assert.deepEqual(local.rejected, [B]); // out of scope
});

test('no requested filter → all accessible sites (MGT-002)', () => {
  assert.deepEqual(effectiveSiteFilter(['auditor'], A, [], ALL).allowed.sort(), ALL);
  assert.deepEqual(effectiveSiteFilter(['reception'], A, [], ALL).allowed, [A]);
});

test('drill-through is gated by the target permission (MGT-006)', () => {
  assert.equal(drillPermission('patient_detail'), 'view_clinical_detail');
  assert.equal(canDrill(['clinical'], 'patient_detail'), true);
  assert.equal(canDrill(['cashier'], 'patient_detail'), false); // cannot reach clinical detail
  assert.equal(canDrill(['finance'], 'finance_detail'), true);
  assert.equal(canDrill(['manager'], 'operational'), true);
});
