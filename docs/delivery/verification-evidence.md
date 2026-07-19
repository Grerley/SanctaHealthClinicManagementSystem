# Verification evidence — Phase 1 vertical-slice core

Captured evidence for the requirements proven so far. Reproduce locally with the commands
shown; CI runs the same suites (`.github/workflows/ci.yml`).

## Test results (reproducible)

```
# Unit — npm test
@sancta/domain        tests 60  pass 60  fail 0
@sancta/clinic-edge   tests  4  pass  4  fail 0
@sancta/cloud-worker  tests  7  pass  7  fail 0

# Integration — real PostgreSQL 16 — npm run test:integration
@sancta/clinic-edge   tests  3  pass  3  fail 0

# Type-check — npm run typecheck
all workspaces: OK
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

## Not yet proven (next increments)

- The **clinic-web PWA** and true offline→reconnect browser flow (Playwright E2E, UAT-01).
- Edge↔cloud transport over TLS (the idempotent apply contract is proven on both ends;
  the wire between them is not yet stood up).
- 72-hour offline, power-loss and bulk-reconnect resilience suites (NFR-001/031).
- Everything gated on the blocking decisions in `decisions-required.md`.
