import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload, DEFAULT_UPLOAD_POLICY } from './documents.ts';

const hash = 'a'.repeat(64);

test('a valid PDF within the size limit passes', () => {
  const r = validateUpload({ filename: 'referral.pdf', mimeType: 'application/pdf', sizeBytes: 1024, sha256: hash });
  assert.equal(r.ok, true);
});

test('a disallowed type is quarantined (DOC-004)', () => {
  const r = validateUpload({ filename: 'macro.docm', mimeType: 'application/vnd.ms-word.document.macroEnabled.12', sizeBytes: 1024, sha256: hash });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'type_not_allowed');
    assert.equal(r.quarantine, true);
  }
});

test('an oversize file is rejected', () => {
  const r = validateUpload({ filename: 'scan.png', mimeType: 'image/png', sizeBytes: DEFAULT_UPLOAD_POLICY.maxSizeBytes + 1, sha256: hash });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'too_large');
});

test('a missing or malformed content hash is rejected and quarantined', () => {
  const r = validateUpload({ filename: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'nothex' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'missing_hash');
});

test('an empty file is rejected', () => {
  const r = validateUpload({ filename: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 0, sha256: hash });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'empty');
});
