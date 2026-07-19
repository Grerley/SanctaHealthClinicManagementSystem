import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxItem } from '@sancta/domain';
import { IdempotentApplier } from '@sancta/domain';
import { type OutboxStore, type SyncTransport, type SyncReceipt, pushOnce, drain } from './index.ts';
import { HttpSyncTransport } from './http-transport.ts';

function item(key: string, deps: string[] = []): OutboxItem {
  return {
    idempotencyKey: key,
    entityType: 'checkout',
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

/** In-memory outbox store for tests. */
class MemStore implements OutboxStore {
  queued: OutboxItem[];
  acknowledged: string[] = [];
  failures: string[] = [];
  constructor(items: OutboxItem[]) {
    this.queued = [...items];
  }
  async takeQueued(limit: number): Promise<readonly OutboxItem[]> {
    return this.queued.slice(0, limit);
  }
  async markAcknowledged(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      this.acknowledged.push(k);
      this.queued = this.queued.filter((i) => i.idempotencyKey !== k);
    }
  }
  async markFailedAttempt(keys: readonly string[], error: string): Promise<void> {
    this.failures.push(...keys.map((k) => `${k}:${error}`));
  }
}

/** Transport backed by the real shared applier (the cloud's dedup rule). */
class AppliedTransport implements SyncTransport {
  applier = new IdempotentApplier();
  fail = false;
  async send(batch: { originSite: string; items: readonly OutboxItem[] }): Promise<SyncReceipt> {
    if (this.fail) throw new Error('network down');
    const outcomes = this.applier.applyBatch(batch.items);
    return {
      originSite: batch.originSite,
      applied: outcomes.filter((o) => o.status === 'applied').map((o) => o.key),
      duplicates: outcomes.filter((o) => o.status === 'duplicate').map((o) => o.key),
      deferred: outcomes.filter((o) => o.status === 'deferred').map((o) => o.key),
      durable: true,
    };
  }
}

test('pushOnce acknowledges applied items and empties the queue', async () => {
  const store = new MemStore([item('k1'), item('k2')]);
  const transport = new AppliedTransport();
  const r = await pushOnce(store, transport, 'S1');
  assert.equal(r.acknowledged, 2);
  assert.equal(store.queued.length, 0);
});

test('a transport failure leaves everything queued (nothing lost, SYN-002)', async () => {
  const store = new MemStore([item('k1'), item('k2')]);
  const transport = new AppliedTransport();
  transport.fail = true;
  const r = await pushOnce(store, transport, 'S1');
  assert.equal(r.failed, 2);
  assert.equal(store.queued.length, 2);
  assert.equal(store.acknowledged.length, 0);
});

test('re-draining after a failure does not duplicate (idempotent, NFR-010)', async () => {
  const store = new MemStore([item('k1'), item('k2')]);
  const transport = new AppliedTransport();
  transport.fail = true;
  await pushOnce(store, transport, 'S1'); // fails, stays queued
  transport.fail = false;
  await drain(store, transport, 'S1'); // succeeds
  // Send the same keys again (simulate duplicate delivery) — cloud sees duplicates.
  const store2 = new MemStore([item('k1'), item('k2')]);
  const r2 = await pushOnce(store2, transport, 'S1');
  assert.equal(transport.applier.appliedCount, 2, 'only two business applies total');
  assert.equal(r2.acknowledged, 2); // acknowledged as duplicates
});

test('drain handles a large backlog in batches (bulk reconnect)', async () => {
  const many = Array.from({ length: 250 }, (_, i) => item('key' + i));
  const store = new MemStore(many);
  const transport = new AppliedTransport();
  const r = await drain(store, transport, 'S1', 100);
  assert.equal(r.acknowledged, 250);
  assert.equal(store.queued.length, 0);
  assert.equal(transport.applier.appliedCount, 250);
});

test('HttpSyncTransport posts a batch and returns the durable receipt', async () => {
  const fakeFetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ originSite: body.originSite, applied: body.items.map((i: OutboxItem) => i.idempotencyKey), duplicates: [], deferred: [], durable: true }),
    };
  };
  const t = new HttpSyncTransport('https://cloud.example/sync/ingress', 'tok', fakeFetch);
  const receipt = await t.send({ originSite: 'S1', items: [item('k1')] });
  assert.deepEqual(receipt.applied, ['k1']);
});

test('HttpSyncTransport throws on a non-ok response (stays queued upstream)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const t = new HttpSyncTransport('https://cloud.example/sync/ingress', 'tok', fakeFetch);
  await assert.rejects(t.send({ originSite: 'S1', items: [item('k1')] }), /503/);
});
