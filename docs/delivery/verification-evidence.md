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

## Reorder suggestions + movement report (real PostgreSQL) — INV-007, INV-011

`packages/domain/src/reorder.ts` + `apps/clinic-edge/{src/inventory-reports.ts,test/inventory-reports.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A SKU at/below its reorder minimum is suggested up to the maximum, with the assumptions (min/max/usage) shown; never auto-ordered | INV-007 | ✅ |
| Average daily use is estimated from trailing dispensing; days-of-cover derived | INV-007 | ✅ |
| The movement report sums received/dispensed/adjustment from the immutable movement records over a period (net reconciles) | INV-011, BR-007 | ✅ |

4 domain unit tests + 2 integration. INV module 7/11 → 9/11.

## Related persons + restricted-record access (real PostgreSQL) — PAT-005, PAT-009

`packages/domain/src/patient-access.ts` + `apps/clinic-edge/{src/patient-relations.ts,test/patient-relations.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Guardians / emergency contacts / household relations are recorded and surfaced (guardians filtered for authority) | PAT-005 | ✅ |
| Sensitive records need a stated purpose; restricted records need an authorised role + purpose; break-glass grants emergency access with a reason | PAT-009 | ✅ |
| Every permitted sensitive/restricted/break-glass access is audited (with purpose) | PAT-009, BR-012 | ✅ |

5 domain unit tests (the access matrix) + 2 integration. PAT module 6/10 → 8/10 (remaining: PAT-006 photo/QR, PAT-010 summary export — both S/P2).

## Config releases, feature flags & system health (real PostgreSQL) — ADM-003/005/006

`packages/domain/src/feature.ts` + `apps/clinic-edge/{src/admin.ts,test/admin.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A config release moves draft→test→approved→published with maker-checker approval; illegal transitions rejected | ADM-003, BR-011 | ✅ |
| Publishing supersedes the prior release; rollback re-publishes it | ADM-003 | ✅ |
| Feature flags gate staged rollout by site AND role; unknown flag → off | ADM-006 | ✅ |
| System health aggregates DB / sync backlog / integration queue / open conflicts and flags attention | ADM-005 | ✅ |

5 domain unit tests (feature eval) + 4 integration. ADM module 4/8 → 7/8.

## Multi-currency conversion + budgets & variance (real PostgreSQL) — FIN-013, FIN-007

`packages/domain/src/currency.ts` + `apps/clinic-edge/{src/finance-budget.ts,test/finance-budget.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A foreign amount converts to base USD by a bps rate in exact integer minor units (no float drift); the original is retained; base converts 1:1 | FIN-013 | ✅ |
| A budget upserts per account + period; an unknown account is rejected | FIN-007 | ✅ |
| Variance compares the budget to the ACTUAL debit-positive net posted to the ledger in the period (reconciles to the GL) | FIN-007, FIN-002 | ✅ |

4 domain unit tests (currency) + 2 integration (budgets). FIN module 8/14 → 10/14.

## Document generation snapshot, versioning & retention (real PostgreSQL) — DOC-002/003/005

`apps/clinic-edge/{src/document-lifecycle.ts,test/document-lifecycle.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A generated document retains an immutable content snapshot + SHA-256 hash | DOC-002 | ✅ |
| Documents supersede/version; a superseded document can't be superseded again; entered-in-error is retained | DOC-003, BR-003 | ✅ |
| Disposal is driven by retention class/date; a legal hold blocks it; disposal within the retention period is refused; disposed content is cleared but metadata + hash retained | DOC-005 | ✅ |

3 integration tests. DOC module 3/7 → 6/7.

## Sensitive-reason-safe appointment notifications — APT-009

`packages/domain/src/notification.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A sensitive appointment's reason is **never** placed in the reminder message (verified with a disclosure check) | APT-009, NFR-018 | ✅ |
| Logistics (date DD/MM/YYYY, time, location) are still present; a non-sensitive reason may be included | APT-009 | ✅ |
| Exposed via `/api/schedule/reminder`, which only ever returns the safe message | APT-009 | ✅ |

3 domain unit tests. APT module 4/9 → 5/9.

## KPI targets & period comparison (real PostgreSQL) — MGT-004, MGT-005

`packages/domain/src/kpi.ts` (targets/banding/comparison) + `apps/clinic-edge/{src/kpi.ts,test/kpi.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| KPI targets/thresholds are effective-dated config (forward-versioned, audited) | MGT-004 | ✅ |
| A value bands green/amber/red against the effective thresholds, respecting higher-better vs lower-better | MGT-004 | ✅ |
| A current period compares to the prior with delta + trend + RAG band + refresh time; snapshots upsert per period | MGT-005 | ✅ |

5 domain unit tests + 3 integration. MGT module 4/10 → 6/10.

## Visit escalation, event log & outcomes (real PostgreSQL) — VIS-004/006/007

`apps/clinic-edge/{src/visit-lifecycle.ts,test/visit-lifecycle.itest.ts}` + migration 0031:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Emergency escalation raises priority (visit + queue) with a required reason, audited | VIS-004 | ✅ |
| An append-only visit-event log yields derived wait/total durations that reconcile to history (never stored totals) | VIS-006 | ✅ |
| Hold/resume respect the visit state machine; terminal outcomes (left-before-seen / refused / cancelled) require a reason, end the visit and clear the queue | VIS-007, BR-003 | ✅ |

3 integration tests. VIS module 4/9 → 7/9.

## Persistent patient banner + stale-offline indicator (browser E2E) — EHR-001

`apps/clinic-web/{src/PatientBanner.tsx,e2e/banner.spec.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Selecting a patient shows a banner (name + MRN + DOB) that persists across tab switches | EHR-001 | ✅ |
| Going offline surfaces a "record may be stale" indicator; coming back online clears it | EHR-001, SYN-001 | ✅ |
| The full accessibility suite still passes with the banner present | NFR-019 | ✅ |

1 browser E2E (11 E2E total, all green). **EHR module now 100%.**

## Multi-site registry + authorisation matrix (real PostgreSQL) — OPS-008

`packages/domain/src/site.ts` (authorisation matrix) + `apps/clinic-edge/{src/site.ts,test/site.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Central roles (manager/administrator/auditor) see the whole network; local users see only their own site | OPS-008 | ✅ |
| A local user with no site sees no site-scoped data; unscoped (network) data is visible to any authenticated user | OPS-008 | ✅ |
| `/api/sites` scopes visibility by the caller's roles + `x-site` | OPS-008, ADM-001 | ✅ |

3 domain unit tests (the matrix) + 1 integration. **OPS module now 100%.**

## External-result reconciliation + cancel/correct without deleting (real PostgreSQL) — ORD-007, ORD-009

`apps/clinic-edge/{src/orders.ts,test/orders-reconcile.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| An external result auto-matches an active order by reference, or queues as unmatched then reconciles to an order (audited); re-reconcile refused | ORD-007 | ✅ |
| An order cancels only with a reason, is **retained** (not deleted) + audited; a cancelled/completed order cannot be re-cancelled | ORD-009 | ✅ |
| A result correction **retains the original** (marked corrected, value preserved) and a new row supersedes it; re-correcting refused | ORD-009 | ✅ |

3 integration tests. ORD module 4/9 → 6/9.

## Formulary search, dispensing worklist & printed prescription (real PostgreSQL) — MED-001/005/006

`apps/clinic-edge/{src/medication.ts,test/medication.itest.ts}`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Formulary search (offline, local DB) returns products with live on-hand from AVAILABLE lots via the derived balance view (1500 across two lots) | MED-001 | ✅ |
| The dispensing worklist shows only signed, undispensed medication requests and clears when marked (cannot re-dispense) | MED-006 | ✅ |
| A legally compliant prescription prints from signed requests with prescriber name + registration number and patient instructions | MED-005 | ✅ |

3 integration tests. MED module 5/10 → 8/10.

## Clinical handover + specialty templates (real PostgreSQL) — EHR-012, EHR-010

`apps/clinic-edge/{src/handover.ts,test/handover.itest.ts}` + migration 0027:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A handover addressed to a staff member (optionally linked to patient/task) reaches the inbox, unacknowledged first, and is acknowledged exactly once | EHR-012 | ✅ |
| Empty message / missing recipient rejected; re-acknowledging is refused | EHR-012 | ✅ |
| Specialty templates (child health, family planning, wound care) resolve as versioned forms and validate content (coded options, required fields) | EHR-010, EHR-003 | ✅ |

2 integration tests. EHR module 9/12 → 11/12 (only EHR-001 patient-banner E2E remains).

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

## Scoped management filters, drill-through & KPI commentary (real PostgreSQL) — MGT-002, MGT-006, MGT-010

`packages/domain/src/mgmt.test.ts` (unit) and `apps/clinic-edge/test/management-scope.itest.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| A central role (manager) may narrow the dashboard to any site; a local role (reception) is silently constrained to its own site — a requested out-of-scope site is reported as `rejected`, never returned | MGT-002 | ✅ |
| No requested filter resolves to all sites the caller may see (central sees the whole network) | MGT-002 | ✅ |
| A clinical role may drill from a summary KPI to patient/clinical detail; a summary-only manager is **denied** and the denial is audited — a dashboard is never a back door to patient detail | MGT-006 | ✅ |
| Operational drill-through stays open to a manager (summary-level detail) | MGT-006 | ✅ |
| KPI commentary is append-only: a second note for the same KPI/period preserves the first; corrective action, owner and due date persist; empty commentary is rejected | MGT-010 | ✅ |

## Appointment waiting list, reminder de-duplication & versioned types (real PostgreSQL) — APT-004, APT-005, APT-007

`packages/domain/src/waitlist.test.ts` (unit) and `apps/clinic-edge/test/appointments-extend.itest.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Waiting-list order is deterministic: higher clinical priority first, first-come (FIFO) within a priority; a released slot is offered to the top *compatible* entry (unspecified service matches any) | APT-004 | ✅ |
| A cancelled appointment re-opens its slot, and `fillReleasedSlot` books the highest-priority waiter into it under a slot lock; filling an already-booked slot is a no-op | APT-004 | ✅ |
| A released slot is re-bookable — the total `UNIQUE(slot_id)` is replaced with a partial unique on *active* appointments, preserving the APT-001 no-double-book guarantee | APT-001, APT-004 | ✅ |
| A reminder queues exactly once per (appointment, kind); a replayed offline-created reminder does not duplicate (idempotent enqueue) | APT-005 | ✅ |
| A reminder for a sensitive appointment never discloses the clinical reason in its body | APT-005, APT-009 | ✅ |
| Appointment types version forward with effective dating; an out-of-order effective date is rejected; resolution as-of a date picks the covering version (duration, prep, deposit) | APT-007 | ✅ |
| Scheduling routes are now deny-by-default (RBAC): booking/capacity require `create`, versioned type config requires `configure`, reads require `view_summary` | APT, ADM-001 | ✅ |

## Break-even planning & approved-data export (real PostgreSQL) — FIN-012, FIN-014

`packages/domain/src/breakeven.test.ts` (unit) and `apps/clinic-edge/test/finance-export.itest.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Break-even rounds up to whole units and reports the covering revenue; a non-divisible fixed cost rounds up (no fractional units) | FIN-012 | ✅ |
| A unit with no positive contribution margin (price ≤ variable cost) makes break-even unreachable — reported explicitly, never a divide-by-zero | FIN-012 | ✅ |
| Investment recovery: funding offsets the up-front investment, a positive monthly surplus recovers the remainder in whole months, and a non-positive surplus reports "never recovers" (null) | FIN-012 | ✅ |
| An approved-data export of a period's posted journal lines always balances (Σ debits = Σ credits); an unbalanced ledger is refused rather than exported | FIN-014 | ✅ |
| The export is idempotent — re-exporting an unchanged period yields the same SHA-256 idempotencyKey (computed over accounting content, never the wall-clock); a new posting changes the key | FIN-014 | ✅ |
| An unknown period is rejected; each export is audited | FIN-014 | ✅ |

## Order sets, patient-safe specimen labels & outbound referrals (real PostgreSQL) — ORD-002, ORD-004, ORD-008

`packages/domain/src/labels.test.ts` (unit) and `apps/clinic-edge/test/orders-extend.itest.ts`:

| Assertion | Requirement | Result |
|-----------|-------------|--------|
| Applying an order set creates one **individual DRAFT** order per item — the set is a convenience, never an auto-approve; nothing is active until a clinician reviews and activates each order (draft → active) | ORD-002 | ✅ |
| An unknown/empty order set is rejected | ORD-002 | ✅ |
| A specimen label is built from initials + DOB + sex + accession only; deriving initials in the domain makes it structurally impossible to print the full name; the full name never appears on the label | ORD-004 | ✅ |
| Accessions are unique, gapless and zero-padded (SPN-000123) | ORD-004 | ✅ |
| An outbound referral tracks its lifecycle sent → accepted → closed with feedback; a closed referral drops off the open queue; illegal transitions and a missing facility are rejected | ORD-008 | ✅ |

## Not yet proven (next increments)

- Edge↔cloud transport currently runs over HTTP in tests; the production wire is HTTPS to
  the Worker (contract identical). TLS termination and Cloudflare Access/WAF are IaC, not
  yet exercised in an automated test.
- The remaining MVP modules (orders/results, full finance, procurement, messaging, etc.).
- Everything ultimately gated on the blocking decisions in `decisions-required.md`.
