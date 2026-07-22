/**
 * Thin query helpers over the D1 interface, so ported handlers read close to the
 * original `pool.query` code. SQLite uses `?` positional placeholders.
 */
import type { D1Database, D1Row } from './d1.ts';

/** First row (or null). */
export async function one<T = D1Row>(db: D1Database, sql: string, params: unknown[] = []): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

/** All rows. */
export async function many<T = D1Row>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

/** Execute a write; returns the number of rows changed (for optimistic-concurrency checks). */
export async function run(db: D1Database, sql: string, params: unknown[] = []): Promise<number> {
  return (await db.prepare(sql).bind(...params).run()).meta.changes;
}

/** A prepared, bound statement — for assembling an atomic `batch()`. */
export function stmt(db: D1Database, sql: string, params: unknown[] = []) {
  return db.prepare(sql).bind(...params);
}
