/**
 * The minimal D1 binding surface our data layer uses, plus a node:sqlite-backed
 * local implementation. Handlers are written against this interface, so the exact
 * same code runs on Cloudflare D1 in production (`env.DB`) and on local SQLite in
 * tests — that is how we prove "no behaviour drift" against the real engine
 * without a network or wrangler.
 *
 * Only the subset we use is modelled (prepare/bind/first/all/run, batch, exec).
 */

export type D1Row = Record<string, unknown>;
export interface D1Result<T = D1Row> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  first<V = unknown>(column: string): Promise<V | null>;
  all<T = D1Row>(): Promise<D1Result<T>>;
  run<T = D1Row>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = D1Row>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

// --- node:sqlite-backed local implementation (tests + local dev) -------------

// node:sqlite is a built-in (Node ≥ 22, behind --experimental-sqlite). Typed
// loosely here to avoid a hard dependency on the experimental type surface.
type SqliteStatement = {
  get(...params: unknown[]): D1Row | undefined;
  all(...params: unknown[]): D1Row[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};
type SqliteDb = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
};

function meta(changes = 0, lastRowId = 0): D1Result['meta'] {
  return { changes, last_row_id: lastRowId, rows_read: 0, rows_written: changes };
}

class LocalStatement implements D1PreparedStatement {
  readonly #db: SqliteDb;
  readonly #sql: string;
  readonly #params: unknown[];
  constructor(db: SqliteDb, sql: string, params: unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }
  bind(...values: unknown[]): D1PreparedStatement {
    return new LocalStatement(this.#db, this.#sql, values);
  }
  #stmt(): SqliteStatement {
    return this.#db.prepare(this.#sql);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async first(column?: string): Promise<any> {
    const row = this.#stmt().get(...this.#params) ?? null;
    if (row === null) return null;
    return column === undefined ? row : (row as D1Row)[column] ?? null;
  }
  async all<T = D1Row>(): Promise<D1Result<T>> {
    const rows = this.#stmt().all(...this.#params) as T[];
    return { results: rows, success: true, meta: meta(0, 0) };
  }
  async run<T = D1Row>(): Promise<D1Result<T>> {
    const r = this.#stmt().run(...this.#params);
    return { results: [], success: true, meta: meta(Number(r.changes), Number(r.lastInsertRowid)) };
  }
}

/** A D1Database backed by a node:sqlite database — for tests and local dev. */
export class LocalD1 implements D1Database {
  readonly #db: SqliteDb;
  constructor(db: SqliteDb) {
    this.#db = db;
    // Match D1: foreign keys enforced.
    this.#db.exec('PRAGMA foreign_keys = ON;');
  }
  prepare(query: string): D1PreparedStatement {
    return new LocalStatement(this.#db, query);
  }
  async batch<T = D1Row>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    // D1 batches are atomic transactions committed sequentially, non-concurrently.
    this.#db.exec('BEGIN');
    try {
      const out: D1Result<T>[] = [];
      for (const s of statements) out.push(await (s as LocalStatement).run<T>());
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.#db.exec(query);
    const count = (query.match(/;/g) ?? []).length;
    return { count, duration: 0 };
  }
}

/** Open an in-memory (or file) LocalD1 using node:sqlite. */
export async function openLocalD1(path = ':memory:'): Promise<LocalD1> {
  const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => SqliteDb };
  return new LocalD1(new DatabaseSync(path));
}
