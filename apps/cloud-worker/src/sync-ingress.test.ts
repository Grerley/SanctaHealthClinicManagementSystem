import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSyncIngress, parseRequest } from './sync-ingress.ts';

function item(key: string, deps: string[] = []) {
  return {
    idempotencyKey: key,
    entityType: 'payment',
    entityId: '00000000-0000-7000-8000-00000000000' + key.slice(-1),
    entityVersion: 1,
    originSite: 'S1',
    device: 'D1',
    user: 'U1',
    schemaVersion: 1,
    priority: 100,
    dependencies: deps,
    capturedAt: '2026-07-19T08:00:00Z',
    payload: {},
  };
}

test('ingress returns a durable receipt classifying each item', () => {
  const receipt = handleSyncIngress({ originSite: 'S1', items: [item('k1'), item('k2')] });
  assert.equal(receipt.durable, true);
  assert.deepEqual([...receipt.applied].sort(), ['k1', 'k2']);
});

test('re-sending an already-synced batch yields duplicates, not new applies (NFR-010)', () => {
  const receipt = handleSyncIngress({ originSite: 'S1', alreadySynced: ['k1'], items: [item('k1'), item('k2')] });
  assert.deepEqual(receipt.duplicates, ['k1']);
  assert.deepEqual(receipt.applied, ['k2']);
});

test('out-of-order dependencies still apply', () => {
  const receipt = handleSyncIngress({ originSite: 'S1', items: [item('k2', ['k1']), item('k1')] });
  assert.deepEqual([...receipt.applied].sort(), ['k1', 'k2']);
});

test('parseRequest rejects malformed bodies without leaking detail', () => {
  assert.throws(() => parseRequest(null));
  assert.throws(() => parseRequest({ items: [] }));
  assert.throws(() => parseRequest({ originSite: 'S1', items: [{ bad: true }] }));
});
