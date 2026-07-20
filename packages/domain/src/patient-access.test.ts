import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patientAccessDecision, assertPatientAccess, PatientAccessError } from './patient-access.ts';

test('normal records need no special access (PAT-009)', () => {
  const d = patientAccessDecision('normal', { roles: ['reception'] });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresAudit, false);
});

test('sensitive records require a stated purpose and are audited (PAT-009)', () => {
  assert.equal(patientAccessDecision('sensitive', { roles: ['clinical'] }).allowed, false);
  const ok = patientAccessDecision('sensitive', { roles: ['clinical'], purpose: 'treatment' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.requiresAudit, true);
});

test('restricted records need an authorised role + purpose (PAT-009)', () => {
  assert.equal(patientAccessDecision('restricted', { roles: ['reception'] }).allowed, false); // not authorised
  assert.equal(patientAccessDecision('restricted', { roles: ['clinical'] }).allowed, false); // authorised but no purpose
  const ok = patientAccessDecision('restricted', { roles: ['clinical'], purpose: 'treatment' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.requiresAudit, true);
  assert.equal(ok.breakGlass, false);
});

test('break-glass allows emergency access to restricted records with a reason (PAT-009)', () => {
  assert.equal(patientAccessDecision('restricted', { roles: ['cashier'], breakGlass: true }).allowed, false); // no reason
  const bg = patientAccessDecision('restricted', { roles: ['cashier'], breakGlass: true, breakGlassReason: 'unconscious patient, emergency' });
  assert.equal(bg.allowed, true);
  assert.equal(bg.breakGlass, true);
  assert.equal(bg.requiresAudit, true);
});

test('assertPatientAccess throws when denied', () => {
  assert.throws(() => assertPatientAccess('restricted', { roles: ['reception'] }), PatientAccessError);
  assert.doesNotThrow(() => assertPatientAccess('sensitive', { roles: ['clinical'], purpose: 'care' }));
});
