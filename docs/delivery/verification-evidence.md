# Verification evidence — Phase 1 vertical-slice core

Captured evidence for the requirements proven so far. Reproduce locally with the commands
shown; CI runs the same suites (`.github/workflows/ci.yml`).

## Test results (reproducible)

```
# Unit — npm test
@sancta/domain        tests 60  pass 60  fail 0
@sancta/sync          tests  6  pass  6  fail 0
@sancta/clinic-edge   tests  4  pass  4  fail 0
@sancta/cloud-worker  tests  7  pass  7  fail 0

# Integration — real PostgreSQL 16 (edge + cloud) — npm run test:integration
@sancta/clinic-edge   tests 10  pass 10  fail 0

# End-to-end — real browser (Chromium) driving the real stack — npm run e2e
@sancta/clinic-web    3 passed

# Type-check — npm run typecheck
all workspaces: OK
```

Local reproduction (a PostgreSQL 16 on 127.0.0.1:5433 with role `sancta`):

```
DATABASE_URL=postgres://sancta@127.0.0.1:5433/sancta_test \
CLOUD_DATABASE_URL=postgres://sancta@127.0.0.1:5433/sancta_cloud \
  npm run test:integration -w @sancta/clinic-edge

PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
DATABASE_URL=... CLOUD_DATABASE_URL=... npm run e2e -w @sancta/clinic-web
```

## What the vertical-slice integration test proves (against real PostgreSQL)

`apps/clinic-edge/test/checkout.itest.ts`, driving `commitCheckout` end-to-end on a database
loaded from `packages/db/migrations/0001_init.sql` + `seed/synthetic-seed.sql`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Dispense + finalised invoice + part-payment + 3 balanced journals + audit + outbox commit in ONE transaction | **BR-008**, SYN-002 | ✅ |
| Stock decremented via FEFO (1500 → 1440); on-hand read only from the derived movement view | INV-005/006, MED-007, **BR-007** | ✅ |
| Trial balance nets to zero (Σ debit = Σ credit = 3220) | **FIN-002**, BR-009 | ✅ |
| Patient AR = invoice 1500 − payment 1000 = 500 outstanding | BIL-006, BR-006 | ✅ |
| Replay of the same checkout is rejected by the idempotency key — **no duplicate** stock/journal rows | **NFR-010**, SYN-003, CLD-003 | ✅ |
| Insufficient stock rolls back the whole checkout — no partial invoice/movement | INV-005, BR-008 | ✅ |

## What the unit suites prove

- **Ledger/posting (FIN-002, BR-009):** every §8.2 accounting event yields a balanced,
  postable batch; system journals reverse via a linked batch, never edit.
- **Stock (BR-007, MED-007/008):** balance = Σ immutable movements; negative-stock blocked;
  FEFO skips expired/quarantined/recalled lots; insufficient dispensable stock throws.
- **Idempotency (NFR-010, SYN-003):** duplicate delivery and full-batch replay create no
  duplicate transactions; dependencies resolve regardless of transmit order; clock drift
  flagged (SYN-007).
- **State machines (BR-003, EHR-008/009):** signed clinical content is append-only — no path
  back to draft; only addendum / entered-in-error permitted.
- **Sync ingress (worker):** returns a durable receipt; re-sending an already-synced batch
  yields duplicates, not new applies (reuses the shared applier — one dedup rule).
- **Cache-safety (CLD-011/NFR-035):** protected responses set `Cache-Control: no-store`.
- **Money:** exact integer minor-unit arithmetic; no floating-point drift.
- **Duplicate detection (PAT-003), pricing (BIL-001/003), ageing (BIL-008):** covered.

## Edge↔cloud synchronisation (real edge + cloud PostgreSQL)

`apps/clinic-edge/test/sync.itest.ts` + `@sancta/sync`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Local checkout queues an outbox item; cloud untouched until push | SYN-003 | ✅ |
| Push synchronises to the cloud store and reconciles to the edge | SYN-004 | ✅ |
| Re-push is idempotent — no duplicate central row | NFR-010, CLD-003 | ✅ |
| Cloud unreachable → item stays queued, drains on recovery, nothing lost | NFR-038, SYN-002 | ✅ |

## Offline resilience (real edge + cloud PostgreSQL)

`apps/clinic-edge/test/resilience.itest.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Abrupt power loss mid-transaction → no partial data; DB recovers, no manual repair | NFR-031, NFR-002 | ✅ |
| Extended internet outage (many local commits) → all durable locally, trial balance nets zero | NFR-001 | ✅ |
| Bulk reconnect drains the whole backlog; cloud reconciles; replay adds nothing | SYN-004, NFR-010, UAT-11 | ✅ |
| Concurrent dispensing during the outage keeps every movement | BR-007 | ✅ |

## Browser E2E (real Chromium driving the real stack)

`apps/clinic-web/e2e/slice.spec.ts` orchestrated by `e2e/harness.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| App shell renders after the network is cut (service-worker cache) | SYN-001 | ✅ |
| Dispense-and-pay commits locally, shows "Pending sync: 1", stock decremented | SYN-002/005 | ✅ |
| "Sync now" reconciles to the cloud with no duplication | SYN-004, NFR-010 (UAT-01 UI) | ✅ |

## Not yet proven (next increments)

- Edge↔cloud transport currently runs over HTTP in tests; the production wire is HTTPS to
  the Worker (contract identical). TLS termination and Cloudflare Access/WAF are IaC, not
  yet exercised in an automated test.
- The remaining MVP modules (orders/results, full finance, procurement, messaging, etc.).
- Concurrency hardening for same-lot depletion races (row-level locking / SERIALIZABLE) —
  current tests use ample stock; near-zero-stock concurrency is a known follow-up.
- Everything ultimately gated on the blocking decisions in `decisions-required.md`.
