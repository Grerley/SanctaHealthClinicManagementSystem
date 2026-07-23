/**
 * The UI-state contract (§6.6). Pure logic — proves every one of the 18 states has
 * a presentation, that "preserved" work is never a destructive state, that
 * attention-worthy states announce, and that the 5-part copy composes honestly
 * (never claims cloud receipt for queued work).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statePresentation, composeStatusCopy } from '../src/state.ts';
import { UI_STATES } from '@sancta/design-tokens';

test('all 18 canonical states have a presentation', () => {
  assert.equal(UI_STATES.length, 18);
  for (const s of UI_STATES) {
    const p = statePresentation(s);
    assert.equal(p.state, s);
    assert.ok(p.label.length > 0);
  }
});

test('failed and conflict preserve work and announce assertively', () => {
  for (const s of ['failed', 'conflict'] as const) {
    const p = statePresentation(s);
    assert.equal(p.preserved, true, `${s} must not read as lost`);
    assert.equal(p.needsAttention, true);
    assert.equal(p.announce, 'assertive');
    assert.equal(p.tone, 'danger');
  }
});

test('saved-to-clinic and waiting-to-sync are preserved and not errors', () => {
  assert.equal(statePresentation('saved-to-clinic').tone, 'success');
  assert.equal(statePresentation('saved-to-clinic').preserved, true);
  assert.equal(statePresentation('waiting-to-sync').preserved, true);
  assert.equal(statePresentation('waiting-to-sync').tone, 'warning');
});

test('the 5-part copy drops empty parts and orders happened -> action', () => {
  const copy = composeStatusCopy({
    happened: 'Payment recorded at the clinic.',
    receipt: 'Waiting to sync.',
    action: '',
  });
  assert.equal(copy, 'Payment recorded at the clinic. Waiting to sync.');
  // Honest: a queued item never claims the cloud received it.
  assert.equal(/cloud (received|confirmed)/i.test(copy), false);
});
