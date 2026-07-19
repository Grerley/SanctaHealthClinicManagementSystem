import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENCOUNTER_TRANSITIONS,
  INVOICE_TRANSITIONS,
  APPOINTMENT_TRANSITIONS,
  VISIT_TRANSITIONS,
  ORDER_TRANSITIONS,
  canTransition,
  assertTransition,
  isSignedImmutable,
  TransitionError,
} from './state-machines.ts';

test('encounter can progress draft -> ready -> signed', () => {
  assert.ok(canTransition(ENCOUNTER_TRANSITIONS, 'draft', 'ready_to_sign'));
  assert.ok(canTransition(ENCOUNTER_TRANSITIONS, 'ready_to_sign', 'signed'));
});

test('signed clinical content is append-only — no edit back to draft (BR-003)', () => {
  assert.equal(canTransition(ENCOUNTER_TRANSITIONS, 'signed', 'draft'), false);
  assert.equal(canTransition(ENCOUNTER_TRANSITIONS, 'signed', 'ready_to_sign'), false);
  assert.throws(() => assertTransition(ENCOUNTER_TRANSITIONS, 'signed', 'draft'), TransitionError);
  // only entered-in-error is permitted from signed
  assert.ok(canTransition(ENCOUNTER_TRANSITIONS, 'signed', 'entered_in_error'));
  assert.ok(isSignedImmutable('signed'));
});

test('invoice cannot skip from draft directly to paid', () => {
  assert.equal(canTransition(INVOICE_TRANSITIONS, 'draft', 'paid'), false);
  assert.ok(canTransition(INVOICE_TRANSITIONS, 'finalised', 'part_paid'));
  assert.ok(canTransition(INVOICE_TRANSITIONS, 'part_paid', 'paid'));
});

test('a voided invoice is terminal', () => {
  assert.deepEqual(INVOICE_TRANSITIONS.voided, []);
  assert.throws(() => assertTransition(INVOICE_TRANSITIONS, 'voided', 'draft'), TransitionError);
});

test('appointment no-show is reachable but terminal', () => {
  assert.ok(canTransition(APPOINTMENT_TRANSITIONS, 'booked', 'no_show'));
  assert.deepEqual(APPOINTMENT_TRANSITIONS.no_show, []);
});

test('visit on-hold can resume to prior active stages', () => {
  assert.ok(canTransition(VISIT_TRANSITIONS, 'in_care', 'on_hold'));
  assert.ok(canTransition(VISIT_TRANSITIONS, 'on_hold', 'in_care'));
});

test('order cannot complete without progressing through in_progress', () => {
  assert.equal(canTransition(ORDER_TRANSITIONS, 'accepted', 'completed'), false);
  assert.ok(canTransition(ORDER_TRANSITIONS, 'in_progress', 'completed'));
});

test('assertTransition returns the target on a legal move', () => {
  assert.equal(assertTransition(ENCOUNTER_TRANSITIONS, 'draft', 'ready_to_sign'), 'ready_to_sign');
});
