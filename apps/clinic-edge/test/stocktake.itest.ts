/**
 * Stocktake with variance + approval (INV-008, UAT-11) against real PostgreSQL.
 * Proves: an exact count posts nothing; a shortfall requires an approver, posts a
 * linked adjustment movement and a shrinkage journal, and the book reconciles to
 * the count afterwards (balance stays movement-derived).
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
import { performStocktake, StocktakeError } from '../src/stocktake.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const LOT = '00000000-0000-7000-8000-000000000a01'; // AMOX lot with 1000 units in seed
const APPROVER = '00000000-0000-7000-8000-0000000000aa';

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

async function lotBalance(lotId: string): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(quantity),0)::int AS n FROM inventory.stock_movement WHERE lot_id=$1`, [lotId]);
  return r.rows[0].n as number;
}
async function shrinkageBal(): Promise<number> {
  const r = await pool.query(`SELECT coalesce(sum(debit_minor)-sum(credit_minor),0)::int AS n FROM finance.journal_line WHERE account_code='5100-SUPPLIES-EXPENSE'`);
  return r.rows[0].n as number;
}

test('an exact count posts no adjustment', { skip }, async () => {
  const res = await performStocktake(pool, { lotId: LOT, countedQty: 1000 });
  assert.equal(res.varianceQty, 0);
  assert.equal(await lotBalance(LOT), 1000);
});

test('a shortfall requires an approver, posts an adjustment + shrinkage, and reconciles (UAT-11)', { skip }, async () => {
  // Count 960 vs book 1000 -> variance -40. Unit cost 10 -> shrinkage 400.
  await assert.rejects(performStocktake(pool, { lotId: LOT, countedQty: 960 }), StocktakeError); // no approver

  const res = await performStocktake(pool, { lotId: LOT, countedQty: 960, approver: APPROVER });
  assert.equal(res.bookQty, 1000);
  assert.equal(res.varianceQty, -40);
  assert.equal(res.adjustmentValueMinor, 400);

  // Book now equals the count via a linked adjustment movement (not an edit).
  assert.equal(await lotBalance(LOT), 960);
  // Shrinkage expense posted 400.
  assert.equal(await shrinkageBal(), 400);
});

test('a negative count is rejected', { skip }, async () => {
  await assert.rejects(performStocktake(pool, { lotId: LOT, countedQty: -1, approver: APPROVER }), StocktakeError);
});
