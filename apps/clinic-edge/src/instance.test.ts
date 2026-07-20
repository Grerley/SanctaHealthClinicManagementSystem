import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode, instanceInfo } from './instance.ts';

test('production is recognised; everything else is non-production (fail-safe)', () => {
  assert.equal(resolveMode('production'), 'production');
  assert.equal(resolveMode('PROD'), 'production');
  assert.equal(resolveMode('training'), 'training');
  assert.equal(resolveMode('test'), 'test');
  assert.equal(resolveMode(undefined), 'test'); // unset → non-production
  assert.equal(resolveMode('anything-else'), 'test');
});

test('a production instance is unmarked; non-production is clearly marked (ADM-007)', () => {
  const prod = instanceInfo({ SANCTA_ENV: 'production' } as NodeJS.ProcessEnv);
  assert.equal(prod.nonProduction, false);
  assert.equal(prod.banner, '');
  assert.equal(prod.syntheticDataOnly, false);

  const training = instanceInfo({ SANCTA_ENV: 'training' } as NodeJS.ProcessEnv);
  assert.equal(training.nonProduction, true);
  assert.match(training.banner, /NON-PRODUCTION \(TRAINING\)/);
  assert.equal(training.syntheticDataOnly, true);

  // Misconfiguration (unset) fails safe to a marked non-production instance.
  const unset = instanceInfo({} as NodeJS.ProcessEnv);
  assert.equal(unset.mode, 'test');
  assert.equal(unset.nonProduction, true);
});
