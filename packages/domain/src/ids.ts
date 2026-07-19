/**
 * Offline-capable identifiers (PAT-001, BR-001, ADR-0006).
 *
 * UUIDv7: 48-bit Unix-millisecond timestamp + random, so ids created on
 * disconnected devices are globally unique AND roughly time-ordered for index
 * locality. Generation never requires central connectivity.
 *
 * Human-readable numbers (MRN, visit, invoice, receipt) are SEPARATE controlled
 * sequences — see `sequence.ts` concepts in the pack (§8.3). This module only
 * provides the UUID primitive and offline receipt-block reservation helpers.
 */

export type Uuid = string;

type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

/**
 * Generate a UUIDv7. `nowMs` and `random` are injectable for deterministic tests
 * (production passes neither).
 */
export function uuidv7(nowMs?: number, random: RandomBytes = defaultRandom): Uuid {
  const ts = Math.floor(nowMs ?? Date.now());
  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  const rand = random(10);
  for (let i = 0; i < 10; i++) bytes[6 + i] = rand[i] as number;

  // version 7 in the high nibble of byte 6
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  // variant 10xx in the high bits of byte 8
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] as number).toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_RE.test(value);
}

/** Extract the embedded millisecond timestamp from a UUIDv7. */
export function uuidv7Timestamp(id: Uuid): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16);
}
