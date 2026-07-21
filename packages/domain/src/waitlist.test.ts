import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderWaitlist, serviceMatches, nextWaitlistCandidate, type WaitlistEntry } from './waitlist.ts';

const e = (id: string, priority: number, createdAt: string, serviceCode: string | null = null): WaitlistEntry => ({
  id, provider: 'p1', serviceCode, priority, createdAt,
});

test('higher priority wins; FIFO breaks ties within a priority (APT-004)', () => {
  const ordered = orderWaitlist([
    e('a', 1, '2026-07-01T09:00:00Z'),
    e('b', 5, '2026-07-01T10:00:00Z'),
    e('c', 5, '2026-07-01T08:00:00Z'), // same priority as b but earlier
  ]);
  assert.deepEqual(ordered.map((x) => x.id), ['c', 'b', 'a']);
});

test('service compatibility: unspecified matches any (APT-004)', () => {
  assert.equal(serviceMatches(null, 'GP'), true);
  assert.equal(serviceMatches('GP', null), true);
  assert.equal(serviceMatches('GP', 'GP'), true);
  assert.equal(serviceMatches('GP', 'DENTAL'), false);
});

test('a released slot goes to the top compatible entry (APT-004)', () => {
  const entries = [
    e('gp-low', 1, '2026-07-01T08:00:00Z', 'GP'),
    e('dental', 9, '2026-07-01T08:00:00Z', 'DENTAL'), // higher priority but wrong service
    e('gp-high', 5, '2026-07-01T09:00:00Z', 'GP'),
  ];
  const pick = nextWaitlistCandidate(entries, { provider: 'p1', serviceCode: 'GP' });
  assert.equal(pick?.id, 'gp-high');

  // No compatible entry → null.
  assert.equal(nextWaitlistCandidate(entries, { provider: 'p2', serviceCode: 'GP' }), null);
});
