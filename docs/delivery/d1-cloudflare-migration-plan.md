# Migration plan — 100% Cloudflare on D1 (SQLite)

**Decision.** Move the app to run entirely on Cloudflare: one Worker serving the
PWA + API, with **Cloudflare D1 (SQLite)** as the database. No external database,
no Docker. The end state lives on the GitHub **`main`** branch and is
**behaviour-preserving — a user must not notice any difference.**

This supersedes the edge/offline model for now. That model is preserved on
`snapshot/edge-first-baseline` and remains conceptually intact (the domain logic
is portable), so a future per-device offline replica (Phase 2) is still possible.

---

## 1. Guiding principles

1. **Behaviour parity is the contract.** The API surface and business behaviour
   do not change. This is *enforced mechanically*, not by inspection:
   - the **OpenAPI/contract gate** must stay green (routes + permissions identical);
   - the **integration test suite** (currently 217 tests) is re-homed onto D1 and
     must stay green — same business assertions, now against the production engine;
   - the **PWA and the `@sancta/domain` rules are unchanged** — only the data
     layer and HTTP transport move.
   If the contract is unchanged and every test passes on D1, a user cannot tell.
2. **Spike the risk first.** The one dangerous part is the transactional/
   concurrency core (money + stock). We port *one* interactive transaction and
   prove it under concurrency **before** committing to the full port — a go/no-go
   gate.
3. **Schema-as-code.** D1's schema is managed by versioned migrations in the repo
   (`wrangler d1 migrations`), applied by the deploy pipeline. Nobody hand-edits
   the database.

## 2. Target architecture

```
   Browser (any device, online)
        │ https
        ▼
   ┌──────────────── ONE Cloudflare Worker (deployed from GitHub main) ────────────────┐
   │  Static Assets  ── serves the React PWA (unchanged)                                │
   │  run_worker_first: ["/api/*"]  ── the API in the fetch handler                     │
   │  Cloudflare Access  ── real authenticated identity → roles (replaces header stand-in)│
   │  http-auth.ts RBAC (reused)   ·   @sancta/domain (reused 100%)                      │
   │        │ D1 binding (env.DB)                                                        │
   └────────┼───────────────────────────────────────────────────────────────────────────┘
            ▼
   Cloudflare D1 (SQLite)   +   R2 (documents/backups)   +   D1 Time Travel (point-in-time restore)
```

## 3. What carries over unchanged vs. what changes

| Unchanged (the expensive, tested core) | Changes (the work) |
|---|---|
| `@sancta/domain` — all business rules | **Schema**: 48 Postgres migrations → a D1 migration set |
| `http-auth.ts` RBAC rules | **Queries**: ~250 handlers' SQL (dialect + placeholders + transactions) |
| The PWA (`clinic-web`) | **Data access**: `pg.Pool`/`PoolClient` → D1 `prepare/bind/run/all/first` + `batch()` |
| Contract/OpenAPI gate, requirement coverage | **Transport**: `node:http` server → Worker `fetch` handler |
| The *business assertions* inside the tests | **Auth**: header stand-in → Cloudflare Access |
| | **Tests**: re-home integration suite from `pg`/Postgres → D1 |
| | **Backup**: `pg_dump`/restore (UAT-16) → D1 Time Travel + export |

## 4. The concurrency model (the core technical decision)

Postgres gives us `BEGIN … SELECT … FOR UPDATE … (logic) … UPDATE … COMMIT`.
D1 has **no row locks and no interactive transactions** — only `batch()` (a
pre-assembled list of statements committed atomically) and auto-commit. So every
interactive read-modify-write is re-expressed with **optimistic concurrency**:

- **Guarded conditional writes.** e.g. stock decrement becomes
  `UPDATE lot SET on_hand = on_hand - ? WHERE id=? AND on_hand >= ?` and we check
  `changes === 0` to detect contention → reject/retry. No oversell without a lock.
- **Atomic multi-statement commits** via `batch()` — values pre-computed in JS
  (FEFO allocation, invoice, payment, balanced journal) then committed all-or-nothing.
- **Idempotency + append-only make this safe.** Every mutating op already carries
  an idempotency key and the ledger is append-only, so replays and races converge
  instead of corrupting mutable state. This is why this app is unusually suited to
  the swap.

This pattern is defined once (Phase D1) and applied everywhere.

## 5. Schema translation rules (Postgres → SQLite/D1)

| Postgres | D1 / SQLite |
|---|---|
| Schemas (`billing.invoice`) | Flatten to `billing_invoice` (no namespaces in SQLite) |
| `uuid` | `TEXT` (we already generate `uuidv7` in app) |
| `bigint` money (minor units) | `INTEGER` (64-bit — exact; money stays integer) |
| `numeric` | `INTEGER` where money-like; else `REAL` or `TEXT` (never floats for money) |
| `timestamptz` | `TEXT` ISO-8601 UTC (default `CURRENT_TIMESTAMP`); format in app/domain |
| `gen_random_uuid()` | app-generated `uuidv7` (already used) |
| Sequences (`nextval`) | counter table with guarded `UPDATE … RETURNING`, or app-generated |
| Enums / domains | `TEXT` + `CHECK` |
| Arrays + GIN (`text[]`, `= ANY`) | JSON text + `json_each`, or a child table; FTS5 for search |
| Partial unique/indexes (`… WHERE`) | **supported** by SQLite — port directly |
| Triggers (audit immutability) | **supported** — port (`RAISE(ABORT)`) |
| `ON CONFLICT`, `RETURNING` | **supported** — keep |
| `DISTINCT ON` | rewrite via `GROUP BY` / window function |
| `$1` placeholders, `::type` casts | `?` placeholders; `CAST()` / affinity |
| Foreign keys | supported; use `PRAGMA defer_foreign_keys` during migrations |
| Date/interval arithmetic, `to_char`, `AT TIME ZONE` | `strftime`/`date`/`julianday` + app-side formatting (already in `domain`) |

## 6. Phased plan (each phase has a hard exit criterion)

| Phase | Work | Exit criterion (Definition of Done) | Size |
|-------|------|-------------------------------------|------|
| **D0 — Scaffold** | Create D1 database; add `d1_databases` + `nodejs_compat` + `[assets]` (`run_worker_first:["/api/*"]`, SPA) to `wrangler.toml`; CI skeleton with `wrangler dev` + local D1 | Worker boots locally, serves the PWA, `/healthz` responds | S |
| **D1 — Concurrency spike** ⭐ | Port ONE interactive transaction (stock decrement / checkout) to the optimistic + `batch()` pattern; write a concurrency test firing parallel checkouts against a scarce SKU | **No oversell, ledger balances, on-hand never negative under concurrency on real D1.** *This is the go/no-go gate for the whole migration.* | M |
| **D2 — Schema port** | Translate all 48 migrations to a D1 migration set (`wrangler d1 migrations`); parity check (table/column/index coverage vs. the Postgres schema) | An empty D1 reaches the full schema via `wrangler d1 migrations apply` | M |
| **D3 — Data-access layer** | A D1-backed "querier" the handlers use; transaction helpers → `batch()`/optimistic; query-translation conventions (`$n`→`?`, casts, dates) | The querier passes a focused unit suite; one module fully ported and green on D1 | M |
| **D4 — Handler port** | Port the ~250 handlers module-by-module; **each module gated by its re-homed integration tests passing on D1**; contract gate stays green throughout | All modules ported; **full integration suite green on D1**; contract unchanged | **L** |
| **D5 — Worker transport** | `node:http` server → Worker `fetch` router (reuse route table, RBAC, domain); serve PWA via Static Assets | `wrangler dev` E2E: the PWA drives the API on the Worker end-to-end; Playwright suite green | M |
| **D6 — Auth** | Cloudflare Access in front; map verified identity → roles; retire the spoofable header stand-in | No unauthenticated access to `/api/*`; RBAC enforced from real identity | M |
| **D7 — Deploy pipeline** | GitHub `main` → Workers Builds (or GH Action); `wrangler d1 migrations apply --remote` in deploy; observability + security scan | A push to a branch deploys a preview; migrations apply automatically; security scan clean | S |
| **D8 — Cutover** | Merge to **`main`**; `main` = the Cloudflare/D1 app; docs; decommission the Node prod path (kept on the snapshot branch) | Production runs on Cloudflare from `main`; all gates green; runbook updated | S |

Critical path: **D1 → D2 → D3 → D4** (schema + data-access + the handler port).
D5–D8 are largely independent and can overlap.

## 7. How "the user notices nothing" is guaranteed

Three mechanical gates, run continuously:
1. **Contract gate** — the OpenAPI spec (routes + permissions) must not change. Any
   drift fails CI.
2. **Integration suite on D1** — the 217 business-behaviour tests are re-homed to
   run against D1 (via `wrangler dev`/local D1). Same assertions, production engine.
   The suite is the behaviour spec; green = parity.
3. **Browser E2E** — the existing Playwright journeys run against the Worker.

The PWA and domain rules are byte-for-byte unchanged, so the only thing that could
leak is a data-layer discrepancy — which the two suites above are designed to catch.

## 8. Risk register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Concurrency correctness (money/stock) under optimistic writes | **High** | Spike-first go/no-go (D1); append-only + idempotency; concurrency tests |
| Test fidelity lost if tests stay on Postgres | High | Re-home the integration suite onto D1 (non-negotiable, part of D4) |
| Date/time drift (formatting, timezones) | Medium | Centralised in `domain`; parity tests on formatted output |
| Public-internet auth (header spoofing) | **High** | Cloudflare Access before any real data (D6) |
| D1 size ceiling (≈10 GB/db) | Low now | Fine for a single clinic; revisit for multi-site scale |
| Backup/restore semantics change | Medium | D1 Time Travel + periodic export to R2; update UAT-16 evidence |
| `batch()` can't express a read-dependent multi-table commit | Medium | Pre-compute in JS then commit as one `batch()`; guarded writes for the racy step |

## 9. Branch & delivery strategy

- Work proceeds on the feature branch `claude/sancta-clinic-system-n4krfb`.
- The pre-migration state is preserved on `snapshot/edge-first-baseline` (rollback).
- At **D8 cutover**, the migration is consolidated to **`main`** so `main` is the
  Cloudflare/D1 production app, deployed from GitHub. From then on, `main` is the
  source of truth and the deploy source.

## 10. Rollback

Every phase is reversible until cutover. If the D1 path fails the D1 spike or the
integration suite cannot reach parity, we fall back to Path A (Postgres +
Hyperdrive) from the same handlers with minimal rework — or to the snapshot
branch. The go/no-go gate at D1 exists precisely so we learn this cheaply.

---

**Immediate next step:** Phase **D1 — the concurrency spike.** Port the stock
decrement/checkout to the D1 optimistic + `batch()` pattern and prove no oversell
under parallel load on real D1. That single experiment validates the entire
migration before we commit to porting all 250 handlers.
