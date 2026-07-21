/**
 * Load & performance harness for the edge API (hardening). Boots the real edge
 * server against real PostgreSQL and drives it under concurrency to measure read
 * latency percentiles + throughput, and — critically — to prove the safety
 * invariants HOLD under contention: concurrent dispenses never oversell stock
 * (on-hand exactly reflects the successful quantities, never negative) and the
 * ledger stays balanced.
 *
 * Opt-in: runs only when RUN_LOAD=1 (and DATABASE_URL is set), so the normal CI
 * integration suite stays fast. Run with:
 *   RUN_LOAD=1 DATABASE_URL=... node --experimental-strip-types --test test/load.itest.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL || process.env['RUN_LOAD'] !== '1';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

let base = '';
let server: import('node:http').Server;
let pool: pg.Pool;
const HEADERS = { 'x-roles': 'reception,clinical,cashier,stock,finance', 'x-user': '00000000-0000-7000-8000-0000000000e1', 'content-type': 'application/json' };

/** Run thunks with bounded concurrency; returns results in order. */
async function withConcurrency<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, () => worker()));
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(allMigrationsSql());
    await c.query(readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8'));
  } finally {
    c.release();
  }
  process.env['DATABASE_URL'] = DATABASE_URL;
  ({ server } = await import('../src/server.ts'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) await pool.end();
});

test('read load: latency percentiles + throughput under concurrency', { skip }, async () => {
  const paths = ['/healthz', '/api/patients', '/api/stock?sku=AMOX-500', '/api/management/dashboard'];
  // Warm-up.
  await Promise.all(paths.map((p) => fetch(base + p, { headers: HEADERS })));

  const N = 800;
  const CONCURRENCY = 40;
  const latencies: number[] = [];
  let failures = 0;

  const thunks = Array.from({ length: N }, (_, i) => async () => {
    const path = paths[i % paths.length]!;
    const t0 = Date.now();
    const res = await fetch(base + path, { headers: HEADERS });
    const dt = Date.now() - t0;
    if (!res.ok) failures++;
    await res.arrayBuffer();
    latencies.push(dt);
  });

  const wallStart = Date.now();
  await withConcurrency(thunks, CONCURRENCY);
  const wallMs = Date.now() - wallStart;

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const rps = Math.round((N / wallMs) * 1000);
  // eslint-disable-next-line no-console
  console.log(`[load] ${N} reqs @ concurrency ${CONCURRENCY}: ${rps} req/s | p50=${p50}ms p95=${p95}ms p99=${p99}ms | failures=${failures}`);

  assert.equal(failures, 0, 'no request should fail under read load');
  assert.ok(p95 < 500, `p95 latency ${p95}ms should be within the 500ms budget`);
  assert.ok(rps > 100, `throughput ${rps} req/s should exceed the 100 req/s floor`);
});

test('write contention: concurrent dispenses never oversell and the ledger stays balanced', { skip }, async () => {
  // Register a batch of distinct synthetic patients so each checkout is genuinely
  // its own transaction (no idempotency de-dup collapsing the concurrency).
  const M = 30;
  const registered = await withConcurrency(
    Array.from({ length: M }, (_, i) => async () => {
      const res = await fetch(base + '/api/patients', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ givenName: `Load${i}`, familyName: `Tester${i}`, dateOfBirth: '1990-01-01', force: true }),
      });
      return ((await res.json()) as { id?: string }).id;
    }),
    20,
  );
  const patients = registered.filter((id): id is string => Boolean(id));
  assert.ok(patients.length >= M - 2, 'the batch of synthetic patients should register');

  const SKU = 'AMOX-500';
  // Deplete the SKU to a scarce level so demand (up to 60 units) exceeds supply —
  // this genuinely exercises the oversell protection under contention.
  const SCARCE = 20;
  await pool.query(
    `INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity)
     SELECT gen_random_uuid(), sku, lot_id, location, 'adjust', -(sum(quantity) - $2)::int
     FROM inventory.stock_movement WHERE sku=$1 GROUP BY sku, lot_id, location HAVING sum(quantity) > 0
     ORDER BY lot_id LIMIT 1`,
    [SKU, SCARCE],
  );
  // Zero out any remaining other lots so exactly SCARCE remains in one lot.
  await pool.query(
    `INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity)
     SELECT gen_random_uuid(), sku, lot_id, location, 'adjust', -sum(quantity)::int
     FROM inventory.stock_movement WHERE sku=$1 GROUP BY sku, lot_id, location HAVING sum(quantity) <> $2 AND sum(quantity) <> 0`,
    [SKU, SCARCE],
  );
  const before2 = ((await (await fetch(`${base}/api/stock?sku=${SKU}`, { headers: HEADERS })).json()) as { onHand: number }).onHand;
  assert.equal(before2, SCARCE, 'stock should be depleted to the scarce level before the storm');

  // Fire one concurrent checkout per patient with varied quantity — genuine contention on the SKU stock.
  const thunks = patients.map((patientId, i) => async () => {
    const quantity = 1 + (i % 3); // 1..3
    const res = await fetch(base + '/api/checkout', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ patientId, sku: SKU, quantity, chargeMinor: 500, paymentMinor: 500, paymentMethod: 'cash' }),
    });
    const body = (await res.json()) as { ok?: boolean; duplicate?: boolean; error?: unknown };
    return { ok: res.ok && body.ok === true, quantity, status: res.status, body };
  });
  const results = await withConcurrency(thunks, 20);

  const succeeded = results.filter((r) => r.ok);
  const dispensed = succeeded.reduce((s, r) => s + r.quantity, 0);
  const after = ((await (await fetch(`${base}/api/stock?sku=${SKU}`, { headers: HEADERS })).json()) as { onHand: number }).onHand;
  // eslint-disable-next-line no-console
  console.log(`[load] write contention: ${succeeded.length}/${M} checkouts succeeded, dispensed ${dispensed} units; stock ${before2} → ${after}`);

  // Scarcity (20 units) is exceeded by demand (up to 60) — so the cap MUST bite.
  assert.ok(succeeded.length < patients.length, 'under scarcity some checkouts must be rejected — proving no oversell');
  assert.ok(dispensed <= before2, 'never dispense more than the available stock');

  // The core invariant: on-hand reflects exactly the successful quantities and is never negative.
  assert.ok(after >= 0, 'stock on-hand must never go negative under contention');
  assert.equal(after, before2 - dispensed, 'on-hand must equal initial minus successfully dispensed');

  // Rejections are graceful (409 insufficient_stock), never a 500 crash.
  for (const r of results) assert.notEqual(r.status, 500, `checkout returned 500 instead of a graceful rejection: ${JSON.stringify(r.body)}`);
  const rejected = results.filter((r) => !r.ok);
  for (const r of rejected) assert.equal(r.status, 409, `a rejected checkout should be 409, got ${r.status}`);

  // The ledger remains balanced after the write storm.
  const tb = (await (await fetch(base + '/api/finance/trial-balance', { headers: HEADERS })).json()) as { balanced: boolean };
  assert.equal(tb.balanced, true, 'trial balance must stay balanced under load');
});
