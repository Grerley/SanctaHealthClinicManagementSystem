import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectedJson, isProtectedPath, PROTECTED_NO_STORE_HEADERS } from './http.ts';

test('protected responses set Cache-Control: no-store (CLD-011, NFR-035)', () => {
  const res = protectedJson({ ok: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('protected-path matcher covers patient, clinical, finance and stock', () => {
  for (const p of ['/patients/123', '/clinical/x', '/billing/inv', '/finance/tb', '/stock/lots', '/sync/ingress', '/auth/login']) {
    assert.ok(isProtectedPath(p), `${p} should be protected`);
  }
  assert.equal(isProtectedPath('/healthz'), false);
  assert.equal(isProtectedPath('/'), false);
});

test('no-store header set is a stable contract', () => {
  assert.equal(PROTECTED_NO_STORE_HEADERS['cache-control'], 'no-store');
});
