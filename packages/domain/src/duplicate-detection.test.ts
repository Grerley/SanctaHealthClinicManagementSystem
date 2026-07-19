import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type PatientCandidate, nameSimilarity, findDuplicates, scoreCandidate } from './duplicate-detection.ts';

// Clearly synthetic data only (never real patient data — pack §1, prompt §7).
const existing: PatientCandidate[] = [
  { id: 'p1', givenName: 'Tendai', familyName: 'Moyo', dateOfBirth: '1990-05-01', sex: 'F', phone: '+263 771 000 111' },
  { id: 'p2', givenName: 'Farai', familyName: 'Ncube', dateOfBirth: '1985-11-20', sex: 'M', phone: '0772222333' },
];

test('name similarity tolerates spelling and case variants', () => {
  assert.ok(nameSimilarity('Tendai', 'tendai') === 1);
  assert.ok(nameSimilarity('Tendai', 'Tendayi') > 0.8);
  assert.ok(nameSimilarity('Moyo', 'Ncube') < 0.4);
});

test('finds a probable duplicate on name + DOB (PAT-003)', () => {
  const incoming = { givenName: 'Tendayi', familyName: 'Moyo', dateOfBirth: '1990-05-01', sex: 'F' };
  const matches = findDuplicates(incoming, existing);
  assert.equal(matches[0]?.candidate.id, 'p1');
  assert.ok(matches[0]!.reasons.includes('same date of birth'));
});

test('same phone strongly boosts the score', () => {
  const incoming = { givenName: 'T', familyName: 'M', phone: '0772222333' };
  const r = scoreCandidate(incoming, existing[1]!);
  assert.ok(r.reasons.includes('same phone'));
});

test('does not flag a clearly different person (never merge on name alone)', () => {
  const incoming = { givenName: 'Rutendo', familyName: 'Sibanda', dateOfBirth: '2001-01-01', sex: 'F' };
  const matches = findDuplicates(incoming, existing);
  assert.equal(matches.length, 0);
});

test('different DOB reduces confidence even with same name', () => {
  const incoming = { givenName: 'Tendai', familyName: 'Moyo', dateOfBirth: '1975-01-01', sex: 'F' };
  const r = scoreCandidate(incoming, existing[0]!);
  const same = scoreCandidate({ ...incoming, dateOfBirth: '1990-05-01' }, existing[0]!);
  assert.ok(same.score > r.score);
});
