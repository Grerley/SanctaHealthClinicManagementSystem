/**
 * Connectivity presentation (§10.2). Availability is derived from clinic/cloud
 * reachability + pending count, NOT navigator.onLine. Proves the exact reference
 * copy and that a lost clinic hub never implies a local save, and pending work is
 * reported as "waiting to sync" (never "sent").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectivityPresentation } from '../src/connectivity.ts';

test('fully connected shows synced copy', () => {
  const p = connectivityPresentation({ clinicReachable: true, cloudReachable: true, pendingCount: 0, syncedMinutesAgo: 2 });
  assert.equal(p.state, 'fully-connected');
  assert.equal(p.copy, 'Clinic connected. Cloud synced 2 minutes ago.');
  assert.equal(p.tone, 'success');
});

test('pending items are reported as waiting to sync, never as sent', () => {
  const p = connectivityPresentation({ clinicReachable: true, cloudReachable: false, pendingCount: 14, syncedMinutesAgo: 5 });
  assert.equal(p.copy, 'Clinic connected. 14 items waiting to sync.');
  assert.equal(/sent|delivered/i.test(p.copy), false);
  assert.equal(p.tone, 'warning');
});

test('lost clinic hub limits device work and never implies a hub save', () => {
  const p = connectivityPresentation({ clinicReachable: false, cloudReachable: false, pendingCount: 0 });
  assert.equal(p.state, 'clinic-unavailable');
  assert.equal(p.copy, 'Clinic connection lost. Work on this device is limited.');
  assert.equal(p.tone, 'danger');
  assert.equal(/saved (locally|to the clinic)/i.test(p.copy), false);
});

test('active sync pass is distinguished', () => {
  const p = connectivityPresentation({ clinicReachable: true, cloudReachable: true, pendingCount: 3, synchronising: true });
  assert.equal(p.state, 'synchronising');
  assert.equal(p.copy, 'Clinic connected. Synchronising 3 items.');
});

test('singular vs plural item phrasing', () => {
  const one = connectivityPresentation({ clinicReachable: true, cloudReachable: false, pendingCount: 1 });
  assert.equal(one.copy, 'Clinic connected. 1 item waiting to sync.');
});
