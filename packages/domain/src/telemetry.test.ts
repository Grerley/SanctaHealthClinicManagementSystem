import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, containsPhi, PHI_KEYS } from './telemetry.ts';

test('redacts PHI-keyed values, keeps operational fields', () => {
  const event = {
    action: 'amend',
    resourceId: '00000000-0000-7000-8000-000000000101',
    count: 3,
    ok: true,
    given_name: 'Amina',
    family_name: 'Okoro',
    phone: '+263771000001',
    content: { history: 'sensitive clinical note' },
  };
  const safe = redact(event);
  assert.equal(safe.action, 'amend');
  assert.equal(safe.resourceId, event.resourceId);
  assert.equal(safe.count, 3);
  assert.equal(safe.ok, true);
  assert.equal(safe.given_name, '[redacted]');
  assert.equal(safe.family_name, '[redacted]');
  assert.equal(safe.phone, '[redacted]');
  assert.equal(safe.content, '[redacted]');
});

test('redacts inside nested objects and arrays', () => {
  const safe = redact({ patients: [{ id: 'a', family_name: 'X' }, { id: 'b', dob: '1990-01-01' }] });
  assert.equal(safe.patients[0]!.id, 'a');
  assert.equal(safe.patients[0]!.family_name, '[redacted]');
  assert.equal(safe.patients[1]!.dob, '[redacted]');
});

test('containsPhi detects unredacted PHI and confirms a clean record', () => {
  assert.equal(containsPhi({ family_name: 'Okoro' }), true);
  assert.equal(containsPhi(redact({ family_name: 'Okoro', id: 'x' })), false);
  assert.equal(containsPhi({ id: 'x', count: 2 }), false);
});

test('the PHI key set covers the core identifiers', () => {
  for (const k of ['given_name', 'family_name', 'date_of_birth', 'phone', 'mrn', 'content']) assert.ok(PHI_KEYS.has(k));
});
