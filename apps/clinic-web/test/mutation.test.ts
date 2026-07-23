/**
 * The §9.2 mutation-contract classification logic. Pure — proves a confirmed commit
 * is only 2xx, a duplicate replay is treated as a (safe) success not a failure, a
 * business 409 surfaces a stable code while keeping the draft, a network drop is a
 * non-committing failure, and the authoritative version/state are threaded through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, newIdempotencyKey } from '../src/mutation.ts';

test('a 2xx is a confirmed local commit', () => {
  const r = classifyResponse(201, { ok: true, version: 2, state: 'signed', permittedNext: ['amend'] });
  assert.equal(r.ok, true);
  assert.equal(r.committedLocally, true);
  assert.equal(r.version, 2);
  assert.equal(r.state, 'signed');
  assert.deepEqual(r.permittedNext, ['amend']);
});

test('a duplicate replay is a safe success, never a failure (no double-post)', () => {
  const r = classifyResponse(409, { duplicate: true });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(r.committedLocally, true);
  assert.equal(r.errorCode, undefined);
});

test('a business 409 surfaces a stable code and does NOT commit', () => {
  const r = classifyResponse(409, { error: { code: 'period_closed', message: 'The period is locked' } });
  assert.equal(r.ok, false);
  assert.equal(r.committedLocally, false);
  assert.equal(r.errorCode, 'period_closed');
  assert.equal(r.errorMessage, 'The period is locked');
});

test('a network drop is a non-committing failure the caller can keep a draft through', () => {
  const r = classifyResponse(0, {});
  assert.equal(r.ok, false);
  assert.equal(r.committedLocally, false);
  assert.equal(r.errorCode, 'network');
});

test('an explicit ok:false in a 200 body is not a commit', () => {
  const r = classifyResponse(200, { ok: false, error: { code: 'insufficient_stock' } });
  assert.equal(r.committedLocally, false);
  assert.equal(r.errorCode, 'insufficient_stock');
});

test('idempotency keys are unique per call', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
  assert.equal(keys.size, 200);
});
