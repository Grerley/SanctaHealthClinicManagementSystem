/**
 * Forward-only migration discipline (NFR-024). The schema evolves only by adding
 * numbered forward migrations that apply in a stable order; there are no down/
 * rollback scripts and no gaps. These properties are what let the edge and cloud
 * rebuild an identical database from the same ordered SQL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationFiles, allMigrationsSql } from './migrations.ts';

test('migrations are numbered, gap-free and strictly increasing (NFR-024)', () => {
  const files = migrationFiles();
  assert.ok(files.length > 0);
  const numbers = files.map((f) => {
    const m = /^(\d{4})_/.exec(f);
    assert.ok(m, `migration ${f} must start with a 4-digit sequence`);
    return Number(m![1]);
  });
  // Strictly increasing, starting at 1, no gaps.
  assert.equal(numbers[0], 1);
  for (let i = 1; i < numbers.length; i++) assert.equal(numbers[i], numbers[i - 1]! + 1, `gap or disorder before ${files[i]}`);
});

test('there are no down/rollback migrations (forward-only, NFR-024)', () => {
  for (const f of migrationFiles()) {
    assert.ok(!/(down|rollback|revert)/i.test(f), `${f} looks like a reverse migration; migrations are forward-only`);
  }
});

test('sort order equals apply order — lexical == numeric (NFR-024)', () => {
  const files = migrationFiles();
  const resorted = [...files].sort();
  assert.deepEqual(files, resorted);
});

test('allMigrationsSql concatenates every migration in order with a header each', () => {
  const sql = allMigrationsSql();
  const files = migrationFiles();
  for (const f of files) assert.ok(sql.includes(`-- ${f}`), `${f} missing from concatenated SQL`);
  // Headers appear in the same order as the files.
  const positions = files.map((f) => sql.indexOf(`-- ${f}`));
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i]! > positions[i - 1]!);
});
