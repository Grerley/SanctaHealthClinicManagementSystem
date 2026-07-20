/**
 * Sync conflict handling for patient demographics (SYN-006, pack §15.5) against
 * real PostgreSQL. Proves: a one-sided offline edit merges automatically; two
 * sites changing the same identity field differently open a conflict case that
 * preserves BOTH versions (never last-write-wins); a human resolution closes the
 * case, writes the chosen value and is audited.
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
import { applyDemographicUpdate, resolveConflictCase, listOpenConflicts, ConflictQueueError } from '../src/conflict.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
const PATIENT = '00000000-0000-7000-8000-000000000101';
const SITE_B = '00000000-0000-7000-8000-0000000000b2';
const NURSE = '00000000-0000-7000-8000-0000000000e1';

async function currentName(): Promise<{ given: string; family: string; phone: string; version: number }> {
  const r = await pool.query(`SELECT given_name, family_name, phone, entity_version FROM identity.patient WHERE id=$1`, [PATIENT]);
  return { given: r.rows[0].given_name, family: r.rows[0].family_name, phone: r.rows[0].phone, version: r.rows[0].entity_version };
}

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

test('a one-sided offline edit merges automatically with no conflict (SYN-006)', { skip }, async () => {
  const before = await currentName();
  // Site B edited the family name offline, from the same base the edge still has.
  const res = await applyDemographicUpdate(pool, {
    patientId: PATIENT,
    base: { family_name: before.family, phone: before.phone },
    changes: { family_name: 'Alpha-Nkomo', phone: before.phone },
    originSite: SITE_B,
    user: NURSE,
  });
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.conflictCaseId, null);
  assert.equal(res.applied['family_name'], 'Alpha-Nkomo');
  const after = await currentName();
  assert.equal(after.family, 'Alpha-Nkomo');
  assert.equal(after.version, before.version + 1); // version bumped exactly once
});

test('concurrent edits to the same identity field open a conflict case preserving both (SYN-006)', { skip }, async () => {
  const base = await currentName(); // both sides start from this ancestor
  // The edge (central) already moved the family name one way...
  await pool.query(`UPDATE identity.patient SET family_name='Alpha-Central' WHERE id=$1`, [PATIENT]);
  // ...while site B moved it another way, based on the same ancestor.
  const res = await applyDemographicUpdate(pool, {
    patientId: PATIENT,
    base: { family_name: base.family },
    changes: { family_name: 'Alpha-Remote' },
    originSite: SITE_B,
    user: NURSE,
  });
  assert.equal(Object.keys(res.applied).length, 0); // nothing auto-applied
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0]!.identity, true);
  assert.ok(res.conflictCaseId);

  // The central value is untouched until a human decides.
  const after = await currentName();
  assert.equal(after.family, 'Alpha-Central');

  // Both versions are preserved in the open queue.
  const open = await listOpenConflicts(pool);
  const mine = open.find((o) => o.id === res.conflictCaseId)!;
  assert.equal(mine.localVersion['family_name'], 'Alpha-Central');
  assert.equal(mine.incomingVersion['family_name'], 'Alpha-Remote');

  // A detection was audited.
  const audit = await pool.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE resource_type='conflict_case' AND resource_id=$1 AND action='amend'`, [res.conflictCaseId]);
  assert.ok((audit.rows[0].n as number) >= 1);
});

test('a human resolution closes the case, writes the chosen value and is audited (SYN-006)', { skip }, async () => {
  const open = await listOpenConflicts(pool);
  assert.ok(open.length >= 1);
  const c = open[0]!;
  const res = await resolveConflictCase(pool, {
    caseId: c.id,
    decisions: [{ field: 'family_name', decision: 'accept_incoming' }],
    by: NURSE,
  });
  assert.equal(res.applied['family_name'], 'Alpha-Remote');
  const after = await currentName();
  assert.equal(after.family, 'Alpha-Remote'); // chosen value written

  // The case is closed and no longer in the open queue.
  const stillOpen = await listOpenConflicts(pool);
  assert.ok(!stillOpen.some((o) => o.id === c.id));

  // Re-resolving a closed case is rejected.
  await assert.rejects(
    resolveConflictCase(pool, { caseId: c.id, decisions: [{ field: 'family_name', decision: 'keep_current' }], by: NURSE }),
    ConflictQueueError,
  );

  // Resolution requires a resolver.
  const open2 = await applyDemographicUpdate(pool, {
    patientId: PATIENT,
    base: { family_name: 'x' },
    changes: { family_name: 'y' },
    originSite: SITE_B,
    user: NURSE,
  });
  await assert.rejects(
    resolveConflictCase(pool, { caseId: open2.conflictCaseId!, decisions: [{ field: 'family_name', decision: 'keep_current' }], by: '' }),
    ConflictQueueError,
  );
});
