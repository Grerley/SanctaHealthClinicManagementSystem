import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDemographics, mergeFields, resolveField, ConflictError, DEMOGRAPHIC_IDENTITY_FIELDS } from './conflict.ts';

test('one-sided change on the incoming side is applied without conflict', () => {
  const base = { given_name: 'Amina', family_name: 'Okoro', phone: '0700000000' };
  const current = { given_name: 'Amina', family_name: 'Okoro', phone: '0700000000' };
  const incoming = { family_name: 'Okoro-Bello' };
  const r = mergeDemographics(base, current, incoming);
  assert.deepEqual(r.applied, { family_name: 'Okoro-Bello' });
  assert.equal(r.conflicts.length, 0);
});

test('two sites changing DIFFERENT fields both merge cleanly', () => {
  const base = { family_name: 'Okoro', phone: '0700000000' };
  // central already took a phone change from site A
  const current = { family_name: 'Okoro', phone: '0711111111' };
  // site B changed the family name from the same base
  const incoming = { family_name: 'Okoro-Bello', phone: '0700000000' };
  const r = mergeFields(base, current, incoming);
  // phone: incoming == base but current moved → incoming keeps base, current already ahead → conflict? No:
  // phone incoming(0700) != current(0711); current(0711) != base(0700) → both differ from... base==incoming.
  // current moved away from base, incoming did NOT → this is a one-sided central change; keep current.
  assert.deepEqual(r.applied, { family_name: 'Okoro-Bello' });
  assert.equal(r.conflicts.length, 0);
});

test('both sides changing the SAME field differently is a genuine conflict', () => {
  const base = { family_name: 'Okoro' };
  const current = { family_name: 'Okoro-Adeyemi' }; // central edit
  const incoming = { family_name: 'Okoro-Bello' }; // offline edit
  const r = mergeDemographics(base, current, incoming);
  assert.equal(Object.keys(r.applied).length, 0);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0]!;
  assert.equal(c.field, 'family_name');
  assert.equal(c.base, 'Okoro');
  assert.equal(c.current, 'Okoro-Adeyemi');
  assert.equal(c.incoming, 'Okoro-Bello');
  assert.equal(c.identity, true);
});

test('agreeing edits (both sides made the same change) produce nothing', () => {
  const base = { sex: 'female' };
  const current = { sex: 'male' };
  const incoming = { sex: 'male' };
  const r = mergeDemographics(base, current, incoming);
  assert.equal(Object.keys(r.applied).length, 0);
  assert.equal(r.conflicts.length, 0);
});

test('non-identity fields conflict too, but are not flagged as identity', () => {
  const base = { phone: '0700000000' };
  const current = { phone: '0711111111' };
  const incoming = { phone: '0722222222' };
  const r = mergeFields(base, current, incoming);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.identity, false);
});

test('resolveField honours the chosen decision', () => {
  const c = { field: 'family_name', base: 'Okoro', current: 'A', incoming: 'B', identity: true };
  assert.equal(resolveField(c, 'accept_incoming'), 'B');
  assert.equal(resolveField(c, 'keep_current'), 'A');
  assert.equal(resolveField(c, 'manual', 'Okoro-Corrected'), 'Okoro-Corrected');
  assert.throws(() => resolveField(c, 'manual'), ConflictError);
});

test('identity field set is the four demographic anchors', () => {
  assert.deepEqual([...DEMOGRAPHIC_IDENTITY_FIELDS], ['given_name', 'family_name', 'date_of_birth', 'sex']);
});
