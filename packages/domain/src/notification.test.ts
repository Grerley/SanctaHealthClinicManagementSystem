import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appointmentReminder, disclosesReason } from './notification.ts';

test('a sensitive reason is NEVER included in the reminder (APT-009)', () => {
  const msg = appointmentReminder({ when: '2026-07-25', time: '09:30', location: 'Clinic B', reason: 'HIV treatment review', sensitive: true });
  assert.equal(disclosesReason(msg, 'HIV treatment review'), false);
  assert.ok(!/hiv/i.test(msg));
  // Logistics are still present.
  assert.ok(msg.includes('25/07/2026'));
  assert.ok(msg.includes('09:30'));
  assert.ok(msg.includes('Clinic B'));
});

test('a non-sensitive reason may be included (APT-009)', () => {
  const msg = appointmentReminder({ when: '2026-07-25', time: '09:30', reason: 'routine review', sensitive: false });
  assert.ok(disclosesReason(msg, 'routine review'));
});

test('no location/time still produces a valid reminder', () => {
  const msg = appointmentReminder({ when: '2026-12-01', sensitive: true });
  assert.ok(msg.includes('01/12/2026'));
  assert.ok(msg.includes('reschedule'));
});
