# Verification evidence — Phase 1 vertical-slice core

Captured evidence for the requirements proven so far. Reproduce locally with the commands
shown; CI runs the same suites (`.github/workflows/ci.yml`).

## Test results (reproducible)

```
# Unit — npm test
@sancta/domain        tests 85  pass 85  fail 0   (money, ledger, stock/FEFO, idempotency,
                                                    state machines, dupes, pricing, ageing,
                                                    cashier, vitals, results, documents)
@sancta/sync          tests  6  pass  6  fail 0
@sancta/clinic-edge   tests  4  pass  4  fail 0
@sancta/cloud-worker  tests  7  pass  7  fail 0

# Integration — real PostgreSQL 16 (edge + cloud) — npm run test:integration
@sancta/clinic-edge   tests 86  pass 86  fail 0   (checkout, sync, resilience, concurrency,
                                                    cashier, patients, triage, debtors,
                                                    scheduling, finance-period, billing, refund,
                                                    orders/results, encounters, inventory,
                                                    stocktake, management, audit, documents,
                                                    visits/queue, finance-statements, comms,
                                                    ops, payables, merge, prescribing)

# End-to-end — real browser (Chromium) driving the real stack — npm run e2e
@sancta/clinic-web    3 passed

# Type-check — npm run typecheck
all workspaces: OK

# Backlog coverage — npm run coverage
functional 43.9% weighted · business rules 76.7% · measurable NFRs 25%
```

## UAT scenarios exercised (pack §22.1)

Automated tests now cover UAT-01 (offline register→dispense→pay→sync), UAT-02 (duplicate
prevention + merge), UAT-03 (implausible vital confirmation), UAT-04 (sign + addendum),
UAT-05 (allergy override), UAT-06 (critical result acknowledgement), UAT-08 (payment
reallocation), UAT-09 (cashier variance approval), UAT-10 (FEFO dispense + COGS + expiry
block), UAT-11 (offline stocktake + bulk reconnect), UAT-12 (expense→payable→payment→GL),
UAT-13 (period close/reopen), UAT-14 (device revocation), UAT-15 (management export),
UAT-16 (edge restore), and **UAT-07 (day-close charge-capture exception)**. All 16 UAT
scenarios are now automated.

## MVP modules built (each with real code + tests on real PostgreSQL)

Patient registration/search/duplicate-check · triage vitals + plausible-range validation ·
clinical encounter sign/addendum/entered-in-error · orders + results + critical-result
acknowledgement · appointment scheduling (no double-book) · dispense→invoice→payment
(atomic) · payment allocation/reallocation · refunds · cashier shift close · debtor ageing ·
financial period close/reopen · goods receipt · stock alerts · stocktake · management
command centre (KPIs + exceptions) · audit search + audited export · edge↔cloud sync ·
offline resilience.

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

## Cashier shift close (real PostgreSQL) — BIL-009, UAT-09

`packages/domain/src/cashier.ts` + `apps/clinic-edge/{src/cashier.ts,test/cashier.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Exact count closes without approval; no variance journal | BIL-009, UAT-09 | ✅ |
| Only cash payments count toward the drawer (mobile-money excluded) | BIL-009 | ✅ |
| Variance above tolerance cannot close without a supervisor; then posts Dr cash-over/short / Cr cash | BIL-009 | ✅ |
| A closed shift cannot be closed again | BIL-009 | ✅ |

## Release gates: security + accessibility (CI-enforced) — NFR-014, NFR-019

`scripts/secret-scan.mjs`, `npm run security`, `apps/clinic-web/e2e/a11y.spec.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| No secrets or non-synthetic credentials in tracked source (private keys, cloud tokens, provider keys, real connection-string passwords) — fails the build otherwise | NFR-014, pack §17 | ✅ |
| Production dependency audit clean at high/critical (`npm audit --omit=dev`); dev-tooling advisories reported non-blocking | NFR-014 | ✅ |
| Every PWA tab (Dispense, Patients, Queue, Command centre) has zero serious/critical WCAG 2.2 AA violations via axe-core in a real browser | NFR-019 | ✅ |
| The gate caught and drove fixes for real defects: sub-4.5:1 button/text contrast and unlabelled form controls | NFR-019 | ✅ |

Both run in CI as required checks (`security` and `e2e + accessibility` jobs).

## Sync conflict handling (real PostgreSQL) — SYN-006, pack §15.5

`packages/domain/src/conflict.ts` (field-level 3-way merge) +
`apps/clinic-edge/{src/conflict.ts,test/conflict.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A one-sided offline demographic edit merges automatically; entity_version bumps once | SYN-006 | ✅ |
| Two sites changing the same identity field differently open a conflict case — central value untouched, **never last-write-wins** | SYN-006, BR-002, pack §15.5 | ✅ |
| The conflict case preserves BOTH the local and incoming values for a human decision | SYN-006, MGT-003 | ✅ |
| A human resolution writes the chosen value, closes the case and is audited; a closed case cannot be re-resolved; resolution requires a resolver | SYN-006, BR-004 | ✅ |
| Open conflicts surface as a management exception linking to the resolution queue | MGT-003 | ✅ |

## Concurrency safety (real PostgreSQL) — INV-005

`apps/clinic-edge/test/resilience.itest.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Two concurrent dispenses of the same lot near depletion: exactly one succeeds, the other is rejected — no oversell to negative (FOR UPDATE row lock) | INV-005, BR-007 | ✅ |

## Not yet proven (next increments)

- Edge↔cloud transport currently runs over HTTP in tests; the production wire is HTTPS to
  the Worker (contract identical). TLS termination and Cloudflare Access/WAF are IaC, not
  yet exercised in an automated test.
- The remaining MVP modules (orders/results, full finance, procurement, messaging, etc.).
- Everything ultimately gated on the blocking decisions in `decisions-required.md`.
