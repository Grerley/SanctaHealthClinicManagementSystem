/**
 * Forward-migration runner (NFR-024, deploy hardening) against real PostgreSQL.
 * Proves the production migrator applies every migration once, records them in
 * public.schema_migrations, and is idempotent (a second run is a no-op) — this is
 * how cloud and local edge databases are brought up to schema without the test
 * harness's drop-and-rebuild.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations, migrationFiles } from '../src/migrations.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

let client: pg.Client;

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  // Start from a clean database so the run is deterministic.
  await client.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
  await client.query(`DROP TABLE IF EXISTS public.schema_migrations`);
});
after(async () => {
  if (!skip && client) await client.end();
});

test('the runner applies every migration once and records them (NFR-024)', { skip }, async () => {
  const first = await applyMigrations(client);
  assert.equal(first.applied.length, migrationFiles().length, 'first run applies every migration');
  assert.equal(first.alreadyApplied, 0);

  const recorded = await client.query(`SELECT count(*)::int AS n FROM public.schema_migrations`);
  assert.equal(recorded.rows[0].n, migrationFiles().length);

  // A representative table from a late migration exists.
  const t = await client.query(`SELECT to_regclass('scheduling.appointment_type') AS r`);
  assert.ok(t.rows[0].r, 'a table from a late migration should exist');
});

test('a second run is idempotent — no migration re-applies (NFR-024)', { skip }, async () => {
  const second = await applyMigrations(client);
  assert.equal(second.applied.length, 0, 'nothing new to apply');
  assert.equal(second.alreadyApplied, migrationFiles().length);
});
