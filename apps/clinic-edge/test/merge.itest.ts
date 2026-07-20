/**
 * Reversible patient merge (PAT-008) against real PostgreSQL. Proves: merging
 * repoints references to the survivor without deleting the source; the merged
 * record is preserved and excluded from search; and the merge reverses exactly.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { doCheckout } from '../src/api.ts';
import { searchPatients } from '../src/patients.ts';
import { mergePatients, unmergePatients, MergeError } from '../src/merge.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const SURVIVOR = '00000000-0000-7000-8000-000000000101';
const MERGED = '00000000-0000-7000-8000-000000000102';
const STEWARD = '00000000-0000-7000-8000-0000000000ab';

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

async function invoicesFor(patientId: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM billing.invoice WHERE patient_id=$1`, [patientId]);
  return r.rows[0].n as number;
}

test('merging repoints references to the survivor and preserves the source (PAT-008)', { skip }, async () => {
  // Give the duplicate an invoice, then merge into the survivor.
  await doCheckout(pool, { patientId: MERGED, sku: 'AMOX-500', quantity: 2, chargeMinor: 200, paymentMinor: 0, paymentMethod: 'cash' });
  assert.equal(await invoicesFor(MERGED), 1);

  const res = await mergePatients(pool, { survivorId: SURVIVOR, mergedId: MERGED, mergedBy: STEWARD });
  assert.ok(res.movedRecords >= 1);

  // The invoice now belongs to the survivor; the merged patient row still exists.
  assert.equal(await invoicesFor(SURVIVOR), 1);
  assert.equal(await invoicesFor(MERGED), 0);
  const stillThere = await pool.query(`SELECT merged_into FROM identity.patient WHERE id=$1`, [MERGED]);
  assert.equal(stillThere.rows[0].merged_into, SURVIVOR);

  // The merged record is excluded from search.
  const found = await searchPatients(pool, 'Sampleperson');
  assert.ok(!found.some((p) => p.id === MERGED));
});

test('a merge can be reversed exactly (PAT-008)', { skip }, async () => {
  const merges = await pool.query(`SELECT id FROM identity.patient_merge WHERE merged_id=$1 AND reversible=true ORDER BY merged_at DESC LIMIT 1`, [MERGED]);
  const mergeId = merges.rows[0].id as string;
  const res = await unmergePatients(pool, { mergeId, user: STEWARD });
  assert.ok(res.restored >= 1);

  // The invoice is back with the (formerly) merged patient, which is searchable again.
  assert.equal(await invoicesFor(MERGED), 1);
  const found = await searchPatients(pool, 'Sampleperson');
  assert.ok(found.some((p) => p.id === MERGED));
});

test('merging a patient into itself is rejected', { skip }, async () => {
  await assert.rejects(mergePatients(pool, { survivorId: SURVIVOR, mergedId: SURVIVOR, mergedBy: STEWARD }), MergeError);
});
