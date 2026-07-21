import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReplicate, planReplication, type ReplicationScope } from './replication.ts';

const SITE_A = 'site-a';
const localScope: ReplicationScope = { sites: [SITE_A], maxSensitivity: 'sensitive', windowDays: 90 };

test('a site-scoped node only holds its own, in-window, permitted-sensitivity records (SYN-008)', () => {
  assert.equal(shouldReplicate({ siteId: SITE_A, sensitivity: 'normal', ageDays: 10 }, localScope), true);
  assert.equal(shouldReplicate({ siteId: 'site-b', sensitivity: 'normal', ageDays: 10 }, localScope), false); // other site
  assert.equal(shouldReplicate({ siteId: SITE_A, sensitivity: 'restricted', ageDays: 10 }, localScope), false); // too sensitive
  assert.equal(shouldReplicate({ siteId: SITE_A, sensitivity: 'normal', ageDays: 200 }, localScope), false); // outside window
  assert.equal(shouldReplicate({ siteId: null, sensitivity: 'normal', ageDays: 1 }, localScope), false); // unsited
});

test('a central node holds everything within its sensitivity ceiling (SYN-008)', () => {
  const central: ReplicationScope = { sites: 'all', maxSensitivity: 'restricted' };
  assert.equal(shouldReplicate({ siteId: 'site-b', sensitivity: 'restricted', ageDays: 999 }, central), true);
  assert.equal(shouldReplicate({ siteId: null, sensitivity: 'normal', ageDays: 999 }, central), true);
});

test('planReplication partitions candidates (SYN-008)', () => {
  const records = [
    { siteId: SITE_A, sensitivity: 'normal' as const, ageDays: 5 },
    { siteId: 'site-b', sensitivity: 'normal' as const, ageDays: 5 },
    { siteId: SITE_A, sensitivity: 'restricted' as const, ageDays: 5 },
  ];
  const { replicated, withheld } = planReplication(records, localScope);
  assert.equal(replicated.length, 1);
  assert.equal(withheld.length, 2);
});
