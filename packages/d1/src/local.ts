/**
 * node:sqlite-backed LocalD1 factory — TEST/LOCAL-DEV ONLY. Kept out of the main
 * barrel so the Cloudflare Worker bundle (which imports @sancta/d1) never pulls in
 * node:sqlite. Production uses the real D1 binding (`env.DB`).
 */
import { LocalD1, type SqliteDb } from './d1.ts';

/** Open an in-memory (or file) LocalD1 using node:sqlite. */
export async function openLocalD1(path = ':memory:'): Promise<LocalD1> {
  const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => SqliteDb };
  return new LocalD1(new DatabaseSync(path));
}
