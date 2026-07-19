# Requirement traceability register

Links every requirement in the pack to its priority, target delivery phase, the planned
verification approach, and (once built) the implementing module and tests. This is the
spine of the definition of done (pack §26): a feature is not complete until its row here
points to implementation **and** passing tests.

Legend — Priority (pack Appendix A): **M** Must · **S** Should · **C** Could.
Status: `planned` · `in-progress` · `built` · `verified`.
Phase: per pack §23 (P1 = operational MVP … P4 = scale/ecosystem).

> Traceability is intentionally exhaustive: 148 functional requirements (PAT…CLD),
> 38 non-functional requirements (NFR), and 15 cross-module business rules (BR).

## Phase 1 verification status (what is proven so far)

Evidence and reproduction in [`../delivery/verification-evidence.md`](../delivery/verification-evidence.md).
The following rows are **built and verified** by passing tests (71 unit + 3 real-PostgreSQL
integration):

- **BR-003, BR-007, BR-008, BR-009, BR-006** — append-only signed content; stock balance =
  Σ movements; atomic dispense; balanced/immutable journals; allocate-before-reduce.
- **FIN-002** (balanced journals from events), **INV-005/006 / MED-007/008** (negative-stock
  block + FEFO + expired-lot block), **BIL-001/003/006/008** (effective-dated pricing,
  override controls, allocation, ageing), **PAT-001/003** (offline UUIDv7, duplicate matcher).
- **SYN-003 / NFR-010** (idempotent outbox apply, no duplicate on replay), **SYN-007** (clock
  drift flag), **CLD-011 / NFR-035** (`no-store` on protected responses).
- **BIL-009 / UAT-09** (cashier shift close: expected-from-payments, denomination count,
  variance, supervisor-approval gate above tolerance, cash-over/short posting).
- **INV-005 concurrency** (FOR UPDATE row lock on lot rows prevents oversell under
  concurrent same-lot dispensing).

These remain `built` (code + tests) rather than `verified` end-to-end until the browser
offline→reconnect flow (UAT-01) and the resilience suites run. Row-level status columns below
still read `planned` where the surrounding module is not yet implemented; the list above is
the authoritative Phase-1 progress marker.

## 7.1 Patient identity & master patient index (PAT)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| PAT-001 | Patient with system UUID, site MRN, optional external IDs; addressable offline | M | P1 | unit + integration (offline create) | planned |
| PAT-002 | Search by identifier, name variants, DOB, phone, sex, guardian, address, QR | M | P1 | integration + E2E; perf (<3 s) | planned |
| PAT-003 | Exact + probabilistic duplicate check before create, on local records | M | P1 | unit (matcher) + E2E UAT-02 | planned |
| PAT-004 | Capture demographics; configurable mandatory/unknown/declined | M | P1 | unit (validation) + contract | planned |
| PAT-005 | Related persons, guardian authority, emergency contact, household | M | P1 | integration | planned |
| PAT-006 | Photograph, print/scan patient card or QR (no PHI in QR) | S | P2 | E2E + security | planned |
| PAT-007 | Identity history, previous names, deceased, provenance | M | P1 | unit + audit assertions | planned |
| PAT-008 | Merge confirmed duplicates without deleting sources; reversible | M | P2 | integration + property | planned |
| PAT-009 | Restricted/sensitive records with extra access rules | S | P2 | authorisation-matrix | planned |
| PAT-010 | Authorised patient summary export/print + disclosure log | S | P2 | security + audit | planned |

## 7.2 Booking, scheduling & reminders (APT)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| APT-001 | Provider/service/room/equipment schedules; no double-book w/o override | M | P1 | unit + integration | planned |
| APT-002 | Create/reschedule/cancel/repeat appointments; actor+time+reason retained | M | P1 | integration + audit | planned |
| APT-003 | Next-eligible-slot search against locally cached schedules | M | P1 | unit + offline E2E | planned |
| APT-004 | Waiting list + fill released capacity by priority | S | P2 | integration | planned |
| APT-005 | Queue SMS/other reminders; offline-created send once, no dup | S | P2 | sync/idempotency | planned |
| APT-006 | Confirmation/cancellation/no-show/late arrival; reportable | M | P1 | integration + report | planned |
| APT-007 | Appointment types, duration, prep, deposits; versioned | S | P2 | unit | planned |
| APT-008 | Day/week/provider/room/service calendar views (<2 s) | M | P1 | E2E + perf | planned |
| APT-009 | Sensitive reasons never in unprotected notifications | M | P1 | security + privacy | planned |

## 7.3 Reception, visits, check-in & queue (VIS)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| VIS-001 | Create visit from walk-in/appointment; unique ID + local timestamp | M | P1 | unit + integration | planned |
| VIS-002 | Check-in after identity confirm; show tasks/balance, not clinical | M | P1 | authorisation + E2E | planned |
| VIS-003 | Queue token, priority, station, status; visible across LAN offline | M | P1 | offline E2E | planned |
| VIS-004 | Clinical priority / emergency escalation, audited, reason required | M | P1 | integration + audit | planned |
| VIS-005 | Transfer between reception/triage/clinician/lab/pharmacy/cashier | M | P1 | integration | planned |
| VIS-006 | Auto waiting/start/end/completion timestamps reconcile to history | M | P1 | unit + report | planned |
| VIS-007 | Hold / left-before-seen / refuse / cancel with reason | M | P1 | integration | planned |
| VIS-008 | Complete only when required tasks resolved or overridden | M | P1 | integration + UAT-07 | planned |
| VIS-009 | De-identified public queue screen (no PHI) | C | P2 | privacy | planned |

## 7.4 Triage, vitals & nursing (TRI)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| TRI-001 | Reason, symptoms, pain, allergy review, infection screen | M | P1 | unit + integration | planned |
| TRI-002 | Vitals (temp, BP, pulse, RR, SpO2, wt, ht, BMI, glucose…) with units | M | P1 | unit | planned |
| TRI-003 | Age/sex/pregnancy plausible-range validation; confirm not reject | M | P1 | unit + UAT-03 | planned |
| TRI-004 | Scores only from validated rules; show components + version | S | P2 | unit | planned |
| TRI-005 | Visible danger-sign escalation; no autonomous diagnosis | M | P1 | integration + safety | planned |
| TRI-006 | Nursing interventions, administered meds, response | M | P1 | integration | planned |
| TRI-007 | Repeat observations + trend within encounter | S | P2 | E2E | planned |
| TRI-008 | Sign/hand off triage; unsigned stays in queue | M | P1 | integration | planned |

## 7.5 Longitudinal EHR (EHR)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| EHR-001 | Persistent patient banner + stale-offline indicator | M | P1 | E2E + offline | planned |
| EHR-002 | Chronological timeline with type/date filter, provenance kept | M | P1 | integration | planned |
| EHR-003 | H/E/A/P via versioned structured forms + narrative | M | P1 | unit + contract | planned |
| EHR-004 | Problem/past/surgical/family/social hx, immunisations, allergies | M | P1 | integration | planned |
| EHR-005 | Coded diagnoses w/ certainty, rank, free-text; offline code search | M | P1 | unit + integration | planned |
| EHR-006 | Care plans, goals, tasks, follow-up dates; overdue on queues | S | P2 | integration | planned |
| EHR-007 | Auto-save drafts; recover interrupted form, no dup encounter | M | P1 | offline + UAT-01 | planned |
| EHR-008 | Clinician sign before final; signed content immutable | M | P1 | unit + property (append-only) | planned |
| EHR-009 | Corrections via addendum / entered-in-error / countersign | M | P1 | integration + UAT-04 | planned |
| EHR-010 | Specialty templates (primary care, child, FP, HIV, wound…) | S | P2 | config test | planned |
| EHR-011 | Visit summary, prescription, sick note, referral letter | S | P2 | doc-gen test | planned |
| EHR-012 | Clinical handover + internal messages linked to patient/task | S | P2 | integration | planned |

## 7.6 Orders, results, procedures & referrals (ORD)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| ORD-001 | Service requests (lab, imaging, procedure, nursing, referral) | M | P2 | integration | planned |
| ORD-002 | Order sets/favourites without bypassing per-patient review | S | P2 | E2E | planned |
| ORD-003 | Order status draft→…→completed/cancelled/not-performed | M | P2 | unit (state machine) | planned |
| ORD-004 | Specimen/procedure labels with patient-safe IDs | S | P2 | E2E | planned |
| ORD-005 | Structured + narrative results, ref range, abnormal flags | M | P2 | integration | planned |
| ORD-006 | Critical-result acknowledgement + timed escalation | M | P2 | integration + UAT-06 | planned |
| ORD-007 | Attach external results; reconcile to order; unmatched queue | M | P2 | integration | planned |
| ORD-008 | Outbound referral + track acceptance/feedback/closure | S | P2 | integration | planned |
| ORD-009 | Cancel/correct without deleting original; reason audited | M | P2 | audit | planned |

## 7.7 Medication, prescribing & dispensing (MED)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| MED-001 | Offline formulary search; stock availability by scope | M | P1 | offline E2E | planned |
| MED-002 | Medication requests: dose/unit/route/freq/duration/qty/instructions | M | P1 | unit (validation) | planned |
| MED-003 | Allergy/interaction/duplication/dose warnings where content exists | S | P2 | unit + UAT-05 | planned |
| MED-004 | Favourites/protocol templates with clinician confirmation | S | P2 | E2E | planned |
| MED-005 | Print legally compliant prescription + patient instructions | M | P1 | doc-gen + print | planned |
| MED-006 | Dispensing worklist from signed prescriptions only | M | P1 | integration | planned |
| MED-007 | FEFO lot, qty, partial, substitution, refusal, counselling — atomic | M | P1 | property + UAT-10 | planned |
| MED-008 | Block dispensing expired/quarantined/recalled lots | M | P1 | unit + UAT-10 | planned |
| MED-009 | Medicine administration w/ time/dose/route/site/performer | S | P2 | integration | planned |
| MED-010 | Charge + COGS on dispense; invoice/stock/COGS reconcile | M | P1 | property + integration | planned |

## 7.8 Inventory, procurement & suppliers (INV)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| INV-001 | Product master: SKU, category, unit, pack conv, controlled, reorder | M | P1 | unit + config | planned |
| INV-002 | Lots/batches, serials, expiry, supplier, landed unit cost | M | P1 | integration | planned |
| INV-003 | Requisitions, approvals, POs, suppliers; SoD thresholds | S | P3 | integration | planned |
| INV-004 | Goods receipt vs PO w/ qty/quality/batch/expiry/discrepancy | M | P3 | integration | planned |
| INV-005 | Immutable movements; balance = Σ movements; block negative | M | P1 | property (ledger) | planned |
| INV-006 | FEFO selection + configurable FIFO/weighted-avg valuation | M | P1 | property + UAT-10 | planned |
| INV-007 | Reorder suggestions (no auto-order) with assumptions | S | P3 | unit | planned |
| INV-008 | Cycle counts + full stocktake, blind, variance, approval | M | P3 | integration + UAT-11 | planned |
| INV-009 | Low/stockout/excess/near-expiry/expired/recall/cold-chain alerts | M | P1 | integration | planned |
| INV-010 | Equipment/fixed assets: tag, location, custodian, service | S | P3 | integration | planned |
| INV-011 | Consumption/wastage/turn/cover/expiry/margin reports | S | P3 | report tie-out | planned |

## 7.9 Billing, cashiering, debtors & payers (BIL)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| BIL-001 | Versioned fee schedules; invoices retain applied version | M | P1 | unit + property (effective-dating) | planned |
| BIL-002 | Auto charge candidates from services/orders/procedures/dispense | M | P1 | integration + UAT-07 | planned |
| BIL-003 | Manual charge/package/discount/waiver/override with reason | M | P1 | authorisation + audit | planned |
| BIL-004 | Estimate/draft/final invoice; finalise locks + controlled number | M | P1 | unit (state machine) | planned |
| BIL-005 | Cash/card/transfer/mobile-money/voucher; unique receipt + local commit | M | P1 | integration + UAT-01 | planned |
| BIL-006 | Allocate one payment across invoices; deposits/part/overpay | M | P1 | property + UAT-08 | planned |
| BIL-007 | Print/send receipt/invoice/statement; reprint w/ copy marker | M | P1 | doc-gen + audit | planned |
| BIL-008 | Debtor ageing, follow-up, promise, plan, provision, write-off | M | P1 | property (ageing) + integration | planned |
| BIL-009 | Cashier shifts: float, count, expected, variance, approval | M | P1 | integration + UAT-09 | planned |
| BIL-010 | Void/refund/reversal via linked compensating transactions | M | P1 | property + audit | planned |
| BIL-011 | Payer coverage/eligibility/pre-auth/claim/remittance (optional) | C | P4 | integration | planned |
| BIL-012 | Reconcile encounters↔invoice↔receipt↔settlement↔ledger | M | P1 | integration + report | planned |

## 7.10 Documents & health-records management (DOC)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| DOC-001 | Upload/scan PDF+image to patient/encounter/order/invoice/… | M | P2 | integration + security | planned |
| DOC-002 | Generate templated docs from approved data; retain snapshot | M | P2 | doc-gen | planned |
| DOC-003 | Versioning, supersede, entered-in-error, legal hold | M | P2 | integration | planned |
| DOC-004 | Malware scan, type allow-list, size limit, content hash | M | P2 | security | planned |
| DOC-005 | Retention/disposal/export by record class + jurisdiction | M | P2 | audit | planned |
| DOC-006 | Indexing + OCR assistive; never silently overwrite source | S | P3 | unit | planned |
| DOC-007 | Track view/print/download/share/disclosure of sensitive docs | M | P2 | audit | planned |

## 7.11 Clinic operations, staff & facilities (OPS)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| OPS-001 | Staff, role, qualification, registration, availability, site | M | P1 | integration | planned |
| OPS-002 | Rooms, service points, equipment, capacity | M | P1 | unit | planned |
| OPS-003 | Tasks, checklists, handovers w/ owner/priority/due/escalation | M | P1 | integration | planned |
| OPS-004 | Opening/safety/cleaning/cold-chain/cash/closing checklists | S | P2 | integration | planned |
| OPS-005 | Incident/complaint/near-miss/failure/corrective action | S | P3 | integration | planned |
| OPS-006 | Equipment maintenance/calibration/downtime | S | P3 | integration | planned |
| OPS-007 | Staff activity/productivity with quality/complexity context | S | P3 | report | planned |
| OPS-008 | Multi-site config; local ops + central oversight | S | P4 | authorisation-matrix | planned |

## 7.12 Finance & management accounting (FIN)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| FIN-001 | Chart of accounts, cost centres, dimensions; versioned codes | M | P1 | unit | planned |
| FIN-002 | Balanced double-entry journals from all events; source ref | M | P1 | property (balanced) + UAT-12 | planned |
| FIN-003 | Controlled manual journal, maker-checker, attachments | M | P3 | authorisation | planned |
| FIN-004 | Cash/bank/mobile-money accounts + statement reconciliation | M | P1 | integration + UAT-12 | planned |
| FIN-005 | Expense request/approval/invoice/payment/cost allocation | M | P3 | integration | planned |
| FIN-006 | Accounts payable, due dates, payment runs, ageing | S | P3 | property | planned |
| FIN-007 | Budgets/forecasts by account/service/site/month; variance | S | P3 | report | planned |
| FIN-008 | Fixed assets: capitalisation, depreciation, disposal | S | P3 | integration | planned |
| FIN-009 | Financial periods: soft/hard close, controlled reopen | M | P1 | integration + UAT-13 | planned |
| FIN-010 | Trial balance, P&L, balance sheet, cash flow, GL, subledgers | M | P1 | report tie-out | planned |
| FIN-011 | Product/service margin from revenue + actual consumption | S | P3 | report | planned |
| FIN-012 | Start-up investment, funding, recovery, break-even | S | P3 | unit | planned |
| FIN-013 | Base USD + optional transaction currency + rates | S | P3 | unit | planned |
| FIN-014 | Export approved accounting data; balanced, idempotent | C | P4 | contract | planned |

## 7.13 Management command centre & analytics (MGT)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| MGT-001 | Role dashboards; every KPI has definition/owner/period/target/drill | M | P1 | E2E + report | planned |
| MGT-002 | Filter by date/site/service/provider/payer/segment in scope | M | P1 | authorisation | planned |
| MGT-003 | Exceptions before summaries; each links to a work queue | M | P1 | E2E | planned |
| MGT-004 | Configurable targets/thresholds/colours/commentary; effective-dated | M | P1 | unit | planned |
| MGT-005 | Trend, prior period, budget, target comparisons + refresh time | M | P1 | report | planned |
| MGT-006 | Authorised drill-through respecting patient/finance permissions | M | P1 | authorisation | planned |
| MGT-007 | Schedule packs; export PDF/XLSX/CSV with as-of/filters/label | S | P2 | export test | planned |
| MGT-008 | KPI catalogue, formula version, lineage, quality status | M | P1 | unit | planned |
| MGT-009 | De-identified analytical dataset separate from live path | S | P3 | privacy | planned |
| MGT-010 | Commentary/action/owner/due against KPI/period | S | P2 | integration | planned |

## 7.14 Patient communication & engagement (COM)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| COM-001 | Consent/preferences per clinical/billing/reminder/outreach | M | P2 | unit (suppression) | planned |
| COM-002 | Queue messages; offline send once; delivery state recorded | S | P2 | sync/idempotency | planned |
| COM-003 | Approved templates w/ language/confidentiality/expiry | M | P2 | unit | planned |
| COM-004 | Inbound responses → tasks, linked to source | S | P3 | integration | planned |
| COM-005 | Assisted printing when digital unavailable/unconsented; audited | M | P2 | print + audit | planned |
| COM-006 | Future patient self-service (booking/docs/balance/pay) | C | P4 | E2E | planned |

## 7.15 Administration, configuration & audit (ADM)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| ADM-001 | Users/roles/permissions/sites/teams; approved, effective-dated | M | P1 | authorisation-matrix | planned |
| ADM-002 | Device registration, trust, last sync, version, revocation | M | P1 | integration + UAT-14 | planned |
| ADM-003 | Versioned config releases: draft/test/approve/publish/rollback | M | P1 | integration | planned |
| ADM-004 | Full audit search; results uneditable; export audited | M | P1 | audit + security | planned |
| ADM-005 | System health/backup/storage/queue/sync/integration monitoring | M | P1 | observability | planned |
| ADM-006 | Feature flags + staged rollout by site/role | S | P2 | integration | planned |
| ADM-007 | Separate prod/training/test; mark non-prod; no PHI copy | M | P1 | security | planned |
| ADM-008 | Local help, guided onboarding, training mode (offline) | S | P2 | E2E | planned |

## 7.16 Offline operation, synchronisation & interoperability (SYN)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| SYN-001 | Cache app code/config/authorised data for core work | M | P1 | offline E2E (NFR-001) | planned |
| SYN-002 | Commit core txns to durable local store before success | M | P1 | power-loss + UAT-01 | planned |
| SYN-003 | Encrypted outbox: idempotency key, version, author, device, time | M | P1 | property (idempotency) | planned |
| SYN-004 | Background delta sync: compression, resume, bounded retry | M | P1 | sync test | planned |
| SYN-005 | Show last sync, pending, failures, conflicts (no jargon) | M | P1 | E2E | planned |
| SYN-006 | Entity-specific conflict handling; queue human review | M | P1 | conflict tests | planned |
| SYN-007 | Detect clock drift; store captured-at + received-at | M | P1 | unit | planned |
| SYN-008 | Scope replication by site/caseload/role/window/sensitivity | M | P1 | authorisation | planned |
| SYN-009 | Versioned REST + FHIR-compatible layer; contract tests | S | P2 | contract | planned |
| SYN-010 | Queue online integrations; failure never blocks local txn | M | P1 | integration | planned |

## 7.17 Cloudflare application & deployment platform (CLD)

| ID | Requirement (abridged) | Pri | Phase | Verification | Status |
|----|------------------------|-----|-------|--------------|--------|
| CLD-001 | PWA + portal via Workers Static Assets + versioned Worker | M | P1 | deploy test | planned |
| CLD-002 | Cloud API/sync ingress/integration gateway in Workers | M | P1 | contract + load + security | planned |
| CLD-003 | Queues w/ bounded retry, DLQ, audited replay (no dup) | M | P1 | queue test (NFR-036) | planned |
| CLD-004 | Managed PostgreSQL as canonical cloud store via Hyperdrive | M | P1 | integration + restore | planned |
| CLD-005 | Hyperdrive caching disabled for sensitive/fresh reads | M | P1 | read-after-write (NFR-035) | planned |
| CLD-006 | Private R2 for docs/reports/backups; hashes, lifecycle, location | M | P2 | security + integrity | planned |
| CLD-007 | Durable Objects for bounded coordination only | S | P1 | architecture test | planned |
| CLD-008 | Cloudflare Access + MFA + least-privilege on mgmt/support | M | P1 | security + access review | planned |
| CLD-009 | WAF managed+custom rules, upload limits, rate limits | M | P1 | security | planned |
| CLD-010 | Tunnel outbound-only for support; disable-72h test | S | P2 | isolation (NFR-038) | planned |
| CLD-011 | `no-store` on protected responses; PHI excluded from logs | M | P1 | header + log tests | planned |
| CLD-012 | Version-controlled Wrangler/Terraform, scoped tokens, secrets | M | P1 | IaC reproduce test | planned |

## 18. Non-functional requirements (NFR-001 … NFR-038)

All 38 NFRs are tracked as measurable test thresholds. Highlights that gate the MVP:
NFR-001 (72 h offline), NFR-002 (local durability across power loss), NFR-005/006
(interactive & save performance), NFR-007 (sync recovery), NFR-010 (ledger invariants +
idempotent replay), NFR-011/012/013 (RPO/RTO/backup verification), NFR-014 (ASVS 5.0 L2),
NFR-016 (audit immutability), NFR-018 (no PHI in telemetry), NFR-019 (WCAG 2.2 AA),
NFR-029 (clinical safety case), NFR-031 (power recovery), NFR-035 (cloud cache safety),
NFR-038 (cloud platform independence). Each has a dedicated test in the test plan and a row
in the release-gate evidence pack (pack §23.1). Full table maintained in the test plan
alongside the acceptance scenarios UAT-01 … UAT-16 (pack §22.1).

## 13.2 Cross-module business rules (BR-001 … BR-015)

Enforced in the trusted server/database layer (never only in the UI). Each rule maps to
property-based / invariant tests: e.g. BR-003 signed content append-only, BR-007 stock
balance = Σ movements, BR-008 dispense atomicity, BR-009 balanced & immutable system
journals, BR-011 segregation of duties. See
[`../architecture/data-and-sync-design.md`](../architecture/data-and-sync-design.md).

## Coverage summary

| Group | Count | Must | Should | Could |
|-------|-------|------|--------|-------|
| PAT | 10 | 7 | 3 | 0 |
| APT | 9 | 5 | 4 | 0 |
| VIS | 9 | 7 | 1 | 1 |
| TRI | 8 | 6 | 2 | 0 |
| EHR | 12 | 7 | 5 | 0 |
| ORD | 9 | 6 | 3 | 0 |
| MED | 10 | 6 | 4 | 0 |
| INV | 11 | 6 | 5 | 0 |
| BIL | 12 | 10 | 0 | 2 |
| DOC | 7 | 6 | 1 | 0 |
| OPS | 8 | 3 | 5 | 0 |
| FIN | 14 | 6 | 7 | 1 |
| MGT | 10 | 6 | 4 | 0 |
| COM | 6 | 3 | 2 | 1 |
| ADM | 8 | 6 | 2 | 0 |
| SYN | 10 | 9 | 1 | 0 |
| CLD | 12 | 10 | 2 | 0 |
| **Functional total** | **165** | **115** | **51** | **6** |
| NFR | 38 | 30 | 8 | 0 |
| BR | 15 | — cross-cutting — | | |

> Note: functional-requirement subtotal (165) counts every row above; the pack numbers them
> within their module prefixes. Appendix B of the pack maps the legacy workbook controls to
> these IDs and is reproduced in [`workbook-traceability.md`](workbook-traceability.md).
