import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, isUuidv7, uuidv7Timestamp } from './ids.ts';

const fixedRandom = (n: number) => new Uint8Array(n).fill(0xab);

test('generates a well-formed v7 uuid', () => {
  const id = uuidv7();
  assert.ok(isUuidv7(id), `expected valid uuidv7, got ${id}`);
});

test('embeds the millisecond timestamp (offline-orderable)', () => {
  const t = 1_700_000_000_000;
  const id = uuidv7(t, fixedRandom);
  assert.equal(uuidv7Timestamp(id), t);
});

test('ids are time-ordered lexicographically', () => {
  const a = uuidv7(1000, fixedRandom);
  const b = uuidv7(2000, fixedRandom);
  assert.ok(a < b, 'earlier timestamp should sort first');
});

test('two ids at the same instant differ by random bits', () => {
  let calls = 0;
  const rnd = (n: number) => new Uint8Array(n).fill(calls++);
  const a = uuidv7(1000, rnd);
  const b = uuidv7(1000, rnd);
  assert.notEqual(a, b);
});

test('rejects non-v7 strings', () => {
  assert.equal(isUuidv7('not-a-uuid'), false);
  assert.equal(isUuidv7('00000000-0000-4000-8000-000000000000'), false); // v4
});
