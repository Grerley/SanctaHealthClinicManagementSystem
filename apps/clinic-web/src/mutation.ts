/**
 * The front-end mutation contract (spec §9.2). Every write carries an idempotency
 * key and a client event id; success is shown ONLY on a confirmed local commit
 * (2xx); a failure returns a stable error code and PRESERVES the caller's draft so
 * nothing entered is lost. Optimistic updates are reserved for reversible low-risk
 * actions — clinical signing, dispensing, payment, stock movement and journal
 * posting must all wait for the confirmed commit before reporting success.
 *
 * Kept framework-free (no React, no DOM at module load) so the classification logic
 * is unit-testable; fetch is only called inside mutate().
 */

export type MutationResult<T> = {
  /** True only on a confirmed local commit (HTTP 2xx). */
  ok: boolean;
  status: number;
  /** True when the clinic hub durably accepted the write. Never true on failure. */
  committedLocally: boolean;
  /** The authoritative object version, when the endpoint returns one. */
  version?: number;
  /** The authoritative domain state (draft/signed/posted/...), when returned. */
  state?: string;
  /** Permitted next actions, when the endpoint returns them. */
  permittedNext?: string[];
  /** A stable error code for business/validation failures (never a raw message to the UI). */
  errorCode?: string;
  errorMessage?: string;
  /** Whether the write was a de-duplicated replay (idempotency key already applied). */
  duplicate?: boolean;
  data?: T;
};

import { sessionRoles, sessionUser } from './session.ts';

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback: 128 bits of randomness as hex (should not be reached in supported runtimes).
  const b = new Uint8Array(16);
  (c ?? ({ getRandomValues: (x: Uint8Array) => x } as Crypto)).getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A globally-unique, offline-capable idempotency key for one attempted write (§8). */
export function newIdempotencyKey(): string { return randomId(); }
/** A distinct client event id, so a retry of the SAME intent reuses the key but is traceable. */
export function newClientEventId(): string { return randomId(); }

/** Shape of the response body we understand (a subset; extra fields are ignored). */
type Envelope = {
  ok?: boolean;
  duplicate?: boolean;
  version?: number;
  entityVersion?: number;
  state?: string;
  status?: string;
  permittedNext?: string[];
  error?: { code?: string; message?: string };
};

/**
 * Classify a response into a MutationResult (pure — no I/O). 2xx is a confirmed
 * commit. 409 is a business/duplicate outcome (surfaced, draft kept). Everything
 * else is a failure with a stable code and the draft preserved by the caller.
 */
export function classifyResponse<T>(status: number, body: unknown): MutationResult<T> {
  const env = (body ?? {}) as Envelope;
  const committed = status >= 200 && status < 300 && env.ok !== false;
  const base: MutationResult<T> = {
    ok: committed,
    status,
    committedLocally: committed,
    data: body as T,
  };
  if (env.duplicate) { base.duplicate = true; base.ok = true; base.committedLocally = true; }
  if (env.version !== undefined) base.version = env.version;
  else if (env.entityVersion !== undefined) base.version = env.entityVersion;
  const state = env.state ?? env.status;
  if (state) base.state = state;
  if (env.permittedNext) base.permittedNext = env.permittedNext;
  if (!committed && !env.duplicate) {
    base.errorCode = env.error?.code ?? (status === 0 ? 'network' : `http_${status}`);
    if (env.error?.message) base.errorMessage = env.error.message;
  }
  return base;
}

/**
 * Perform a confirmed-commit mutation. Sends the idempotency key + client event id
 * so a queue replay or user retry never duplicates a clinical/financial/stock
 * transaction (§8). Returns a MutationResult; the CALLER preserves its draft on
 * `!ok` (this function never discards user input). A network error surfaces as a
 * failure (status 0), not a thrown exception the screen has to catch blindly.
 */
export async function mutate<T>(
  url: string,
  body: unknown,
  opts: { idempotencyKey?: string; clientEventId?: string; method?: 'POST' | 'PUT' | 'PATCH' } = {},
): Promise<MutationResult<T>> {
  const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
  const clientEventId = opts.clientEventId ?? newClientEventId();
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        'x-roles': sessionRoles(),
        'x-user': sessionUser(),
        'x-idempotency-key': idempotencyKey,
        'x-client-event-id': clientEventId,
      },
      body: JSON.stringify(body),
    });
    let parsed: unknown = {};
    try { parsed = await res.json(); } catch { /* empty / non-JSON body */ }
    return classifyResponse<T>(res.status, parsed);
  } catch {
    // Network unreachable — the write did NOT commit; the caller keeps the draft.
    return classifyResponse<T>(0, {});
  }
}
