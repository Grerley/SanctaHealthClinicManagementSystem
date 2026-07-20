import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, assertCan, canViewClinicalDetail, canApprove, assertSegregation, AuthorisationError } from './rbac.ts';

test('deny by default: an unlisted permission is refused', () => {
  assert.equal(can(['reception'], 'sign'), false);
  assert.equal(can(['reception'], 'view_clinical_detail'), false);
  assert.throws(() => assertCan(['reception'], 'sign'), AuthorisationError);
});

test('clinical role can sign and see clinical detail; cashier cannot', () => {
  assert.ok(can(['clinical'], 'sign'));
  assert.ok(canViewClinicalDetail(['clinical']));
  assert.equal(canViewClinicalDetail(['cashier']), false);
});

test('an administrator does NOT inherit clinical detail access (pack §5.1)', () => {
  assert.equal(canViewClinicalDetail(['administrator']), false);
  assert.ok(can(['administrator'], 'configure'));
  assert.equal(can(['administrator'], 'view_clinical_detail'), false);
});

test('cashier can bill and receive payment but not sign clinical content', () => {
  assert.ok(can(['cashier'], 'receive_payment'));
  assert.equal(can(['cashier'], 'sign'), false);
});

test('multiple roles union their permissions', () => {
  assert.ok(can(['reception', 'cashier'], 'receive_payment'));
  assert.ok(can(['reception', 'cashier'], 'create'));
});

test('maker-checker: a user cannot approve their own transaction (BR-011)', () => {
  assert.equal(canApprove('user-1', 'user-1'), false);
  assert.equal(canApprove('supervisor', 'user-1'), true);
  assert.throws(() => assertSegregation('user-1', 'user-1'), AuthorisationError);
  assert.doesNotThrow(() => assertSegregation('supervisor', 'user-1'));
});

test('auditor is read-only (no create/amend/approve)', () => {
  assert.ok(can(['auditor'], 'view_summary'));
  assert.equal(can(['auditor'], 'create'), false);
  assert.equal(can(['auditor'], 'approve'), false);
});
