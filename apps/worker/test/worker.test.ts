/**
 * The Worker fetch handler, exercised end-to-end against LocalD1 (the same SQLite
 * engine as D1) with a stub ASSETS binding — so the routing, RBAC and the D1
 * handlers are verified here without deploying. This is the deploy skeleton's
 * proof: health, a read, deny-by-default RBAC, the flagship checkout write, and
 * the static-asset fallthrough.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openLocalD1 } from '@sancta/d1/local';
import { applyD1Migrations } from '@sancta/d1/migrations';
import { receiveStock } from '@sancta/d1';
import worker from '../src/index.ts';
import type { Env } from '../src/routes.ts';

let env: Env;
let assetsCalls: number;

const STAFF = { 'x-roles': 'reception,clinical,cashier,stock', 'x-user': 'demo' };

beforeEach(async () => {
  const db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name) VALUES ('p1','SCC-1','Ada','Lovelace')`).run();
  await receiveStock(db, { sku: 'AMOX-500', lotId: 'lot-1', expiryDate: '2027-01-01', unitCostMinor: 12, location: 'MAIN', quantity: 100 });
  assetsCalls = 0;
  env = {
    DB: db,
    ASSETS: { fetch: async () => { assetsCalls++; return new Response('<!doctype html><title>Sancta</title>', { headers: { 'content-type': 'text/html' } }); } },
  };
});

async function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  return worker.fetch(new Request('https://app.example' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }), env);
}

test('healthz reports the cloud/D1 plane', async () => {
  const res = await call('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', plane: 'cloud', db: 'd1' });
});

test('a read endpoint returns data from D1 (GET /api/patients)', async () => {
  const res = await call('GET', '/api/patients', { headers: STAFF });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { patients: Array<{ mrn: string }> };
  assert.equal(body.patients.length, 1);
  assert.equal(body.patients[0]!.mrn, 'SCC-1');
});

test('RBAC denies by default (no roles → 403)', async () => {
  const res = await call('GET', '/api/patients'); // no x-roles
  assert.equal(res.status, 403);
});

test('the flagship checkout runs on the Worker against D1 (POST /api/checkout)', async () => {
  const res = await call('POST', '/api/checkout', {
    headers: STAFF,
    body: {
      dispense: { sku: 'AMOX-500', quantity: 10, patientId: 'p1', encounterId: 'enc-1', invoiceId: 'inv-1', chargeMinor: 1500, asOfDate: '2026-07-19', postingDate: '2026-07-19', location: 'MAIN', device: 'd1', user: 'u1', site: 's1' },
      paymentMinor: 500, paymentMethod: 'cash', now: 1_700_000_000_000,
    },
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json() as { cogsMinor: number }).cogsMinor, 120);

  // Stock is drawn down; a replay is rejected as a duplicate (409).
  const stock = await call('GET', '/api/stock?sku=AMOX-500', { headers: STAFF });
  assert.equal((await stock.json() as { onHand: number }).onHand, 90);
  const replay = await call('POST', '/api/checkout', { headers: STAFF, body: {
    dispense: { sku: 'AMOX-500', quantity: 10, patientId: 'p1', encounterId: 'enc-1', invoiceId: 'inv-1', chargeMinor: 1500, asOfDate: '2026-07-19', postingDate: '2026-07-19', location: 'MAIN', device: 'd1', user: 'u1', site: 's1' },
    paymentMinor: 500, paymentMethod: 'cash', now: 1_700_000_000_000,
  } });
  assert.equal(replay.status, 409);
});

test('non-API paths fall through to static assets (the PWA)', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.equal(assetsCalls, 1);
  assert.match(await res.text(), /Sancta/);
});
