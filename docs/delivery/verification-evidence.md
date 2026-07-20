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

## Care plans + clinical document generation (real PostgreSQL) — EHR-006, EHR-011

`packages/domain/src/docgen.ts` (pure generators) +
`apps/clinic-edge/{src/care-plan.ts,src/docgen.ts,test/care-plan.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A care plan carries goals + dated follow-ups; overdue follow-ups surface on a queue and clear when completed (cannot re-complete) | EHR-006 | ✅ |
| A visit summary assembles from the encounter's real diagnoses + plan | EHR-011 | ✅ |
| Prescription (≥1 item), sick note (end ≥ start) and referral (destination required) generate from patient data, DD/MM/YYYY | EHR-011, NFR-020 | ✅ |

4 domain unit tests (generator validation) + 3 integration. EHR module 7/12 → 9/12.

## Clinical history, coded diagnoses & draft recovery (real PostgreSQL) — EHR-004/005/007

`apps/clinic-edge/{src/ehr.ts,test/ehr.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Structured history (problem/past/surgical/family/social/immunisation/allergy) captured + status-tracked; invalid category rejected | EHR-004 | ✅ |
| Diagnoses coded from an offline-searchable code table (resolves display) or free-text, with certainty + rank; unknown code / bad certainty / empty rejected | EHR-005 | ✅ |
| An interrupted draft recovers to the **same** encounter (exactly one open draft), never a duplicate; after signing, autosave is refused and a fresh draft opens | EHR-007, BR-003 | ✅ |

The approved diagnosis code **system/version is decision B5**; a synthetic placeholder set seeds non-production (no autonomous decision support). 3 integration tests. EHR module 4/12 → 7/12.

## Facility operations: resources, checklists, incidents, maintenance (real PostgreSQL) — OPS-002/004/005/006

`apps/clinic-edge/{src/facility.ts,test/facility.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Rooms/service points/equipment track capacity + status; available capacity excludes resources in maintenance | OPS-002 | ✅ |
| A checklist run is `complete` only when every required item is answered; missing items are returned | OPS-004 | ✅ |
| An incident cannot be closed without a corrective action; open incidents rank by severity | OPS-005 | ✅ |
| Maintenance/calibration becomes "due" on/before its date and clears when performed (cannot re-complete) | OPS-006 | ✅ |

4 integration tests. OPS module 2/8 → 6/8 (remaining: OPS-007 productivity report [P3], OPS-008 multi-site [P4]).

## Triage assessment, danger signs & sign/hand-off (real PostgreSQL) — TRI-001/004/005/006/007/008

`packages/domain/src/triage.ts` (danger signs + early-warning score) +
`apps/clinic-edge/{src/triage.ts,test/triage-assessment.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| The assessment captures reason/symptoms/pain(0–10)/allergy review/infection screen | TRI-001 | ✅ |
| Danger signs are computed from captured vitals as visible escalations — **never a diagnosis** (no diagnosis field; `action:'escalate'`) | TRI-005 | ✅ |
| A transparent early-warning score carries its components + rule version and bands low/medium/high | TRI-004 | ✅ |
| Nursing interventions + the patient's response are recorded | TRI-006 | ✅ |
| Repeat observations produce a per-parameter trend within the encounter | TRI-007 | ✅ |
| An **unsigned triage stays in the queue** (highest EWS first) and leaves it only when signed; cannot sign twice or without an assessment | TRI-008 | ✅ |

6 domain unit tests (danger-sign severity ordering, no-diagnosis invariant, score transparency/banding) + 3 integration. TRI module now 100%.

## IaC integrity + forward-only migrations (CI-enforced) — CLD-012, NFR-037, NFR-024

`scripts/iac-check.mjs` (`npm run iac`) + `packages/db/src/migrations.test.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Wrangler + Terraform are present and git-tracked; environments isolated ([env.staging]/[env.production]; TF `environment` var) | CLD-012, NFR-037 | ✅ |
| No inline secrets: TF credentials come from variables marked `sensitive = true`; Wrangler secrets set out-of-band; no literal tokens/keys/connection strings | CLD-012, NFR-037 | ✅ |
| Migrations are numbered, gap-free, strictly increasing; forward-only (no down/rollback); lexical order == apply order | NFR-024 | ✅ |
| `allMigrationsSql` concatenates every migration in order | NFR-024 | ✅ |

The IaC gate runs in the `build-test` CI job. It validates reproducibility inputs statically; a real `terraform apply` / `wrangler deploy` remains gated on a live Cloudflare account and the B2/B3 decisions.

## Instance mode marking + no-PHI telemetry — ADM-007, NFR-018, NFR-025

`apps/clinic-edge/src/instance.ts` + `packages/domain/src/telemetry.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Production is recognised; anything not explicitly "production" fails safe to a marked non-production instance | ADM-007 | ✅ |
| Non-production instances are clearly marked (banner, `nonProduction`, `syntheticDataOnly`) at `/healthz` and `/api/instance` | ADM-007 | ✅ |
| Telemetry redaction masks PHI-keyed values (name, DOB, phone, content, mrn…) in nested objects/arrays while keeping ids/counts | NFR-018 | ✅ |
| `containsPhi` confirms a redacted record is clean; the 500 handler logs stack + correlation id only (no request body/PHI) and returns only a correlation id | NFR-025, NFR-018 | ✅ |

6 unit tests (2 instance, 4 telemetry).

## FHIR-compatible read layer + locale conventions — SYN-009, NFR-020

`packages/domain/src/{fhir.ts,locale.ts}` + `apps/clinic-edge/{src/fhir.ts,test/fhir.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Internal patients project onto FHIR R4 Patient resources (identifier/name/gender/birthDate/telecom, deceasedDateTime) and a searchset Bundle | SYN-009 | ✅ |
| A CapabilityStatement declares the read-only FHIR surface (fhirVersion 4.0.1) | SYN-009 | ✅ |
| Edge endpoints read real rows: `/api/fhir/Patient?id=`, `?identifier=`, `/api/fhir/metadata` | SYN-009 | ✅ |
| Locale conventions centralised and tested: DD/MM/YYYY dates, USD base currency, en-GB | NFR-020 | ✅ |

This completes SYN-009 (versioned REST contract gate + FHIR-compatible layer). 5 domain unit tests + 2 integration.

## Online-integration queue: never blocks local, retry/DLQ/replay (real PostgreSQL) — SYN-010, CLD-003

`apps/clinic-edge/{src/integration-queue.ts,test/integration-queue.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| An integration is enqueued inside the local transaction; a failing delivery never rolls back the local write | SYN-010, NFR-038 | ✅ |
| Delivery has bounded retry and dead-letters after max attempts; the DLQ transition is audited | CLD-003, NFR-036 | ✅ |
| A dead-lettered item replays idempotently and is delivered exactly once; an already-delivered item cannot be replayed | CLD-003, NFR-010 | ✅ |
| A duplicate idempotency key is never enqueued or delivered twice | NFR-010, SYN-003 | ✅ |

## Versioned structured clinical forms + patient timeline (real PostgreSQL) — EHR-003, EHR-002

`packages/domain/src/forms.ts` (schema + validator) +
`apps/clinic-edge/{src/forms.ts,src/encounters.ts,src/timeline.ts,test/forms.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| An encounter bound to a form can only be signed with content valid for that exact form version (required fields present, typed, coded; no stray keys) | EHR-003, BR-003 | ✅ |
| Forms are versioned and effective-dated; a later revision adding a mandatory field does not change how an earlier (v1-bound) encounter validates | EHR-003 | ✅ |
| A form definition needs ≥1 field and a forward-dated revision; changes are audited | EHR-003, BR-012 | ✅ |
| The patient timeline assembles encounters, addenda, observations and results chronologically, each carrying provenance (author + timestamp) | EHR-002 | ✅ |
| The timeline supports filtering by event type and date window | EHR-002 | ✅ |

Form validation covered by 7 unit tests (types, codes, required, unknown keys, effective-dated resolution).

## Configurable demographic capture policy (real PostgreSQL) — PAT-004

`packages/domain/src/demographics.ts` (validation) +
`apps/clinic-edge/{src/demographics.ts,src/patients.ts,test/demographics.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A configurable field policy governs registration (given/family/DOB mandatory, DOB may be unknown, phone may be declined) | PAT-004 | ✅ |
| Registration rejects a missing mandatory field | PAT-004 | ✅ |
| A mandatory field may be satisfied by a permitted unknown/declined marker (never silently skipped); the marker is retained on the patient | PAT-004 | ✅ |
| A marker not permitted for a field is rejected | PAT-004 | ✅ |
| The policy is administrable — making a field mandatory tightens what registration accepts; the config change is audited | PAT-004, BR-012 | ✅ |

Domain validation covered by 8 unit tests (all issues reported at once, whitespace ≠ value, value+marker conflict).

## Effective-dated pricing & priced service charges (real PostgreSQL) — BIL-001, BIL-003, BR-005

`packages/domain/src/pricebook.ts` (resolve/apply) +
`apps/clinic-edge/{src/pricing.ts,test/pricing.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A quote resolves the fee version in force on the date — a mid-year price change (CONSULT-GP v1 1000 → v2 1200 + 15% tax) resolves correctly by date | BIL-001, BR-005 | ✅ |
| No fee effective before the schedule starts / for an unknown service is rejected | BIL-001 | ✅ |
| A price away from standard needs a reason; one outside the min/max band needs an approver | BIL-003 | ✅ |
| Charging a service creates an invoice line that retains the applied rule version, standard, applied, adjustment and tax — a later price change never rewrites it | BIL-001, BR-005 | ✅ |
| The finalisation journal balances and splits tax to a liability (Dr AR / Cr Revenue / Cr Tax payable); outstanding = applied + tax; trial balance stays balanced | BIL-001, FIN-002 | ✅ |
| An out-of-band charge is rejected without an approver; with one, the override reason + approver are retained on the line | BIL-003, BR-011 | ✅ |
| The fee schedule is revised forward-dated (min ≤ standard ≤ max enforced; new date must post-date the current version) | BIL-001 | ✅ |

## Versioned chart of accounts, cost centres & dimensions (real PostgreSQL) — FIN-001

`packages/domain/src/chart.ts` (effective-dated resolver + code/type validation) +
`apps/clinic-edge/{src/chart.ts,test/chart.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| The whole chart is versioned; each account carries an effective-dated definition (v1 backfill) | FIN-001 | ✅ |
| Defining an account rejects duplicate codes and invalid code/type formats | FIN-001, BR-009 | ✅ |
| Revising an account adds a new version and resolves the correct definition by date; history is never rewritten; a revision must move forward in time; deactivation drops it from the as-of chart | FIN-001 | ✅ |
| Cost centres are governed reference data; a journal tagged with an unknown/inactive cost centre is blocked at the posting choke point, a known active one posts | FIN-001, BR-010 | ✅ |
| Accounting dimensions are a managed registry (dimension + values); an unknown dimension is rejected | FIN-001 | ✅ |
| Every chart/cost-centre/dimension change is audited as a config action | BR-012 | ✅ |

## API contract gate (CI-enforced) — SYN-009, pack §22

`docs/api/openapi.json` (versioned contract) + `scripts/{gen-openapi,contract-check}.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Every implemented `/api` route (81 operations) is documented in the OpenAPI 3.1 contract; no undocumented endpoint | SYN-009 | ✅ |
| Every documented operation is implemented; no phantom documentation | SYN-009 | ✅ |
| Each operation's declared `x-permission` matches the permission the server actually enforces — the contract cannot misstate protection | SYN-009, ADM-001 | ✅ |
| Drift is caught: a tampered permission fails `npm run contract`; `npm run openapi:gen` regenerates and restores agreement | SYN-009 | ✅ |

Runs in the `build-test` CI job. The FHIR interoperability layer (remainder of
SYN-009) is a later phase.

## Finance close loop: manual journal + month-end close (real PostgreSQL) — FIN-003, FIN-004, FIN-010

`packages/domain/src/close.ts` (closing-entry math) +
`apps/clinic-edge/{src/manual-journal.ts,src/finance-close.ts,test/finance-close.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| An unbalanced manual-journal draft is rejected before it reaches a checker | FIN-002, BR-009 | ✅ |
| A maker cannot post their own journal; a different checker posts a balanced batch that lands in the ledger (maker-checker) | FIN-003, BR-011 | ✅ |
| A posted journal cannot be re-posted; a checker can reject a draft with a reason and it never posts; both steps audited | FIN-003, BR-012 | ✅ |
| Month-end close clears revenue and expense to retained earnings via a balanced closing batch (profit credits equity, loss debits) | FIN-004 | ✅ |
| A period cannot be closed twice, and posting into a hard-closed period is blocked | FIN-004, BR-010 | ✅ |
| The balance sheet balances (assets = liabilities + equity) before and after the close — earnings reclassified within equity, total unchanged | FIN-010 | ✅ |

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
