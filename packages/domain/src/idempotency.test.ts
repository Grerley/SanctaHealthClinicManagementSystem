import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type OutboxItem, IdempotentApplier, clockDriftFlag } from './idempotency.ts';

function item(key: string, dependencies: string[] = []): OutboxItem {
  return {
    idempotencyKey: key,
    entityType: 'payment',
    entityId: 'pay-' + key,
    entityVersion: 1,
    originSite: 'S1',
    device: 'D1',
    user: 'U1',
    schemaVersion: 1,
    priority: 1,
    dependencies,
    capturedAt: '2026-07-19T08:00:00Z',
    payload: {},
  };
}

test('applying the same item twice is a no-op duplicate (NFR-010)', () => {
  const a = new IdempotentApplier();
  assert.equal(a.apply(item('k1')).status, 'applied');
  assert.equal(a.apply(item('k1')).status, 'duplicate');
  assert.equal(a.appliedCount, 1);
});

test('duplicate delivery in a batch creates no duplicate transaction', () => {
  const a = new IdempotentApplier();
  const outcomes = a.applyBatch([item('k1'), item('k1'), item('k2')]);
  const applied = outcomes.filter((o) => o.status === 'applied').length;
  const dupes = outcomes.filter((o) => o.status === 'duplicate').length;
  assert.equal(applied, 2);
  assert.equal(dupes, 1);
  assert.equal(a.appliedCount, 2);
});

test('dependencies are resolved regardless of transmit order', () => {
  const a = new IdempotentApplier();
  // k3 depends on k2 depends on k1, delivered out of order
  const outcomes = a.applyBatch([item('k3', ['k2']), item('k2', ['k1']), item('k1')]);
  assert.ok(outcomes.every((o) => o.status === 'applied'));
  assert.equal(a.appliedCount, 3);
});

test('an item with an unsatisfiable dependency stays deferred', () => {
  const a = new IdempotentApplier();
  const outcomes = a.applyBatch([item('k5', ['missing'])]);
  assert.equal(outcomes[0]?.status, 'deferred');
  assert.equal(a.appliedCount, 0);
});

test('replay against an already-synced set is fully idempotent', () => {
  const a = new IdempotentApplier(['k1', 'k2']);
  const outcomes = a.applyBatch([item('k1'), item('k2')]);
  assert.ok(outcomes.every((o) => o.status === 'duplicate'));
  assert.equal(a.appliedCount, 0);
});

test('clock drift beyond threshold is flagged (SYN-007)', () => {
  const base = Date.parse('2026-07-19T08:00:00Z');
  assert.equal(clockDriftFlag(base, base + 60_000), false);
  assert.equal(clockDriftFlag(base, base + 10 * 60_000), true);
});
