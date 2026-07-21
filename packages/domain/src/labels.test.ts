import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialsOf, specimenLabel, formatAccession } from './labels.ts';

test('initials are the only identity fragment; full name never appears (ORD-004)', () => {
  assert.equal(initialsOf('Mary Jane Watson'), 'MJW');
  assert.equal(initialsOf('  chidi   okafor '), 'CO');
});

test('a specimen label carries positive ID but not the full name (ORD-004)', () => {
  const label = specimenLabel({
    accession: formatAccession(123),
    initials: initialsOf('Mary Jane Watson'),
    dob: '1990-04-20',
    sex: 'F',
    orderCode: 'FBC',
    collectedOn: '2026-07-21',
  });
  assert.equal(label.accession, 'SPN-000123');
  assert.match(label.line1, /SPN-000123/);
  assert.match(label.line1, /FBC/);
  assert.match(label.line2, /MJW/);
  assert.match(label.line2, /20\/04\/1990/); // DD/MM/YYYY
  assert.match(label.line3, /21\/07\/2026/);
  // The full name must never leak onto the label.
  const whole = [label.line1, label.line2, label.line3].join(' ');
  assert.ok(!/mary/i.test(whole));
  assert.ok(!/watson/i.test(whole));
});

test('accession numbers are zero-padded and prefixed (ORD-004)', () => {
  assert.equal(formatAccession(1), 'SPN-000001');
  assert.equal(formatAccession(987654), 'SPN-987654');
  assert.equal(formatAccession(5, 'PROC'), 'PROC-000005');
});
