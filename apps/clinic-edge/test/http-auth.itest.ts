/**
 * HTTP authorisation enforcement (ADM-001) against the real edge server + real
 * PostgreSQL. Proves the central deny-by-default guard: a request with no roles is
 * forbidden; a request whose roles lack the required permission is forbidden; a
 * request with a sufficient role is allowed. Public routes (healthz) need no auth.
 *
 * Skips unless DATABASE_URL is set.
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
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

let baseUrl = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;

before(async () => {
  if (skip) return;
  // Reset the DB before the server opens its pool.
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
  await c.query(allMigrationsSql());
  await c.query(readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8'));
  await c.end();

  process.env['DATABASE_URL'] = DATABASE_URL;
  const mod = await import('../src/server.ts');
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (skip || !server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(baseUrl + path, init);
}

test('healthz is public (no auth required)', { skip }, async () => {
  const r = await req('/healthz');
  assert.equal(r.status, 200);
});

test('a protected GET with no roles is forbidden (deny-by-default)', { skip }, async () => {
  const r = await req('/api/patients?q=Alpha');
  assert.equal(r.status, 403);
});

test('a role lacking the permission is forbidden', { skip }, async () => {
  // 'auditor' cannot dispense (checkout requires dispense).
  const r = await req('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roles': 'auditor' },
    body: JSON.stringify({ patientId: '00000000-0000-7000-8000-000000000101', sku: 'AMOX-500', quantity: 1, chargeMinor: 100, paymentMinor: 0, paymentMethod: 'cash' }),
  });
  assert.equal(r.status, 403);
});

test('a sufficient role is allowed', { skip }, async () => {
  // 'reception' has discover -> patient search allowed.
  const r = await req('/api/patients?q=Alpha', { headers: { 'x-roles': 'reception' } });
  assert.equal(r.status, 200);

  // 'clinical' has dispense -> checkout allowed (201).
  const r2 = await req('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roles': 'clinical' },
    body: JSON.stringify({ patientId: '00000000-0000-7000-8000-000000000101', sku: 'AMOX-500', quantity: 1, chargeMinor: 100, paymentMinor: 0, paymentMethod: 'cash' }),
  });
  assert.equal(r2.status, 201);
});

test('management export requires the export permission', { skip }, async () => {
  const forbidden = await req('/api/management/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roles': 'reception' },
    body: JSON.stringify({ exportedBy: '00000000-0000-7000-8000-0000000000ac' }),
  });
  assert.equal(forbidden.status, 403);

  const allowed = await req('/api/management/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roles': 'manager' },
    body: JSON.stringify({ exportedBy: '00000000-0000-7000-8000-0000000000ac' }),
  });
  assert.equal(allowed.status, 200);
});
