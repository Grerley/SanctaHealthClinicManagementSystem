/**
 * Multi-site registry (OPS-008), instance marking (ADM-007) and FHIR reads
 * (SYN-009) on D1. Runs on real SQLite. Proves: site visibility follows the
 * authorisation matrix (central sees all, local sees own); a non-production
 * instance is clearly marked synthetic-only; and patients project to FHIR
 * Patient resources with merged records excluded from search.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerSite, listSitesForUser, SiteError } from '../src/site.ts';
import { resolveMode, instanceInfo } from '../src/instance.ts';
import { fhirPatientById, fhirPatientSearch } from '../src/fhir.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('site visibility follows the authorisation matrix', async () => {
  const branch = await registerSite(db, { code: 'BR1', name: 'Branch 1' });
  // A central role (administrator) sees the whole network (main + branch).
  const central = await listSitesForUser(db, ['administrator'], null);
  assert.ok(central.length >= 2);
  // A local reception user sees only their own site.
  const local = await listSitesForUser(db, ['reception'], branch.id);
  assert.equal(local.length, 1);
  assert.equal(local[0]?.id, branch.id);
  await assert.rejects(() => registerSite(db, { code: '', name: 'x' }), SiteError);
});

test('a non-production instance is clearly marked synthetic-only', async () => {
  assert.equal(resolveMode('prod'), 'production');
  assert.equal(resolveMode('training'), 'training');
  assert.equal(resolveMode(undefined), 'test'); // fail-safe
  const prod = instanceInfo('production');
  assert.equal(prod.nonProduction, false);
  assert.equal(prod.banner, '');
  const train = instanceInfo('training');
  assert.equal(train.nonProduction, true);
  assert.equal(train.syntheticDataOnly, true);
  assert.match(train.banner, /NON-PRODUCTION/);
});

test('patients project to FHIR resources; merged records are excluded from search', async () => {
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name, sex, date_of_birth) VALUES ('f1','MRN-F1','Rosalind','Franklin','f','1920-07-25')`).run();
  await db.prepare(`INSERT INTO identity_patient (id, mrn, given_name, family_name, merged_into) VALUES ('f2','MRN-F2','Ros','Franklin','f1')`).run();
  const one = await fhirPatientById(db, 'f1');
  assert.equal(one?.resourceType, 'Patient');
  assert.equal(one?.id, 'f1');
  const hits = await fhirPatientSearch(db, 'MRN-F');
  assert.equal(hits.length, 1); // merged f2 excluded
  assert.equal(hits[0]?.id, 'f1');
  assert.equal(await fhirPatientById(db, 'ghost'), null);
});
