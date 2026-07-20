import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFhirPatient, toFhirBundle, capabilityStatement } from './fhir.ts';
import { formatDateDDMMYYYY, formatCurrency, BASE_CURRENCY, LOCALE } from './locale.ts';
import { money } from './money.ts';

const P = { id: '00000000-0000-7000-8000-000000000101', mrn: 'SCC-000101', givenName: 'Amina', familyName: 'Okoro', sex: 'F', dateOfBirth: '1990-05-01', phone: '+263 771 000 001', deceased: false, deceasedAt: null };

test('maps an internal patient to a FHIR R4 Patient', () => {
  const f = toFhirPatient(P);
  assert.equal(f.resourceType, 'Patient');
  assert.equal(f.id, P.id);
  assert.equal(f.identifier?.[0]?.value, 'SCC-000101');
  assert.equal(f.name?.[0]?.family, 'Okoro');
  assert.deepEqual(f.name?.[0]?.given, ['Amina']);
  assert.equal(f.gender, 'female');
  assert.equal(f.birthDate, '1990-05-01');
  assert.equal(f.telecom?.[0]?.value, '+263 771 000 001');
});

test('maps sex to FHIR gender, deceased to deceasedDateTime', () => {
  assert.equal(toFhirPatient({ ...P, sex: 'M' }).gender, 'male');
  assert.equal(toFhirPatient({ ...P, sex: null }).gender, 'unknown');
  assert.equal(toFhirPatient({ ...P, sex: 'X' }).gender, 'other');
  const dead = toFhirPatient({ ...P, deceased: true, deceasedAt: '2026-07-15' });
  assert.equal(dead.deceasedDateTime, '2026-07-15');
  assert.equal(toFhirPatient({ ...P, deceased: true, deceasedAt: null }).deceasedBoolean, true);
});

test('a bundle wraps resources as a searchset', () => {
  const b = toFhirBundle([toFhirPatient(P)]);
  assert.equal(b.resourceType, 'Bundle');
  assert.equal(b.type, 'searchset');
  assert.equal(b.total, 1);
  assert.equal((b.entry[0]!.resource as { resourceType: string }).resourceType, 'Patient');
});

test('the CapabilityStatement declares a read-only Patient surface', () => {
  const c = capabilityStatement('0.1.0') as { resourceType: string; fhirVersion: string; rest: Array<{ resource: Array<{ type: string }> }> };
  assert.equal(c.resourceType, 'CapabilityStatement');
  assert.equal(c.fhirVersion, '4.0.1');
  assert.equal(c.rest[0]!.resource[0]!.type, 'Patient');
});

test('locale conventions: DD/MM/YYYY, USD, en-GB (NFR-020)', () => {
  assert.equal(formatDateDDMMYYYY('1990-05-01'), '01/05/1990');
  assert.throws(() => formatDateDDMMYYYY('01/05/1990'));
  assert.equal(BASE_CURRENCY, 'USD');
  assert.equal(LOCALE, 'en-GB');
  assert.equal(formatCurrency(money(1250)), 'USD 12.50');
});
