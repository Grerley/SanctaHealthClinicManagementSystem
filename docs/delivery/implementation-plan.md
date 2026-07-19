# Phased implementation plan

Aligned to the pack's delivery roadmap (§23). Durations are indicative, assume one
cross-functional squad and timely clinical/finance/ops decisions, and are **not** a
commercial estimate. Each phase exits only through its release gate with signed evidence.

## Phase 0 — discovery & safety baseline (current)

**Exit scope:** validate scope, users, jurisdiction, clinical content, finance depth,
hardware and migration; confirm Cloudflare account, database provider, data locations and
threat model; establish hazard log, data-protection impact assessment and target
architecture.

- [x] Read the full pack; build the requirement inventory + traceability register.
- [x] Context, deployment and trust-boundary diagrams.
- [x] ADRs for material choices (0001–0006).
- [x] Cloudflare deployment map + edge boundary.
- [x] Data & synchronisation design.
- [x] First vertical slice + E2E acceptance test.
- [x] Risk register; blocking-decisions register.
- [ ] Owners assigned to blocking decisions (§decisions-required) — **needs product/clinical/finance/DPO**.
- [ ] Hazard log + DPIA started (structure only until clinical + DPO owners engage).

**Dependency:** Phase 1 build starts once the blocking decisions have owners and the
Cloudflare account + managed PostgreSQL provider/region are confirmed.

## Phase 1 — operational MVP (12–16 weeks)

**Depends on:** Phase 0 decisions; Cloudflare account; managed PostgreSQL provider.

**Step 2 — production foundation (first):** monorepo + CI (lint, type-check, unit,
integration, contract, security, e2e); local dev environment; clinic-edge container +
install/upgrade/rollback; Cloudflare dev/staging/prod via IaC; DB migrations; observability
(no PHI); secrets pattern; synthetic seed data; audit + authorisation + sync primitives.
*No production environment ships with default passwords, open buckets, public DB ports,
broad tokens or permissive Access policies.*

**Step 3 — the vertical slice** (see `vertical-slice.md`), demonstrated offline + reconciled.

**Step 4 — remaining MVP modules:** patient master; appointment + walk-in; queue; triage;
encounter; prescription; basic dispensing; service catalogue; invoice; payment; debtor;
cashier close; core stock; core dashboards; users/roles; audit; clinic edge; Workers
deployment; Queues-based sync; PostgreSQL via Hyperdrive; private R2; Access + WAF.

**Gate (pack §23.1):** patient-safety, financial-integrity, offline-resilience (72 h outage,
power loss, bulk reconnect, conflicts on target hardware), migration (2 rehearsals),
security/privacy (threat model, ASVS 5.0 L2, pen-test, access review, backup restore),
usability, operations.

## Phase 2 — clinical & records depth (8–12 weeks)

Orders & results; referrals; configurable forms; care plans; clinical documents; critical
result workflow; patient messaging; advanced clinical reporting; documents module (DOC-*);
FHIR profile + contract tests (SYN-009).

## Phase 3 — finance, procurement & inventory control (10–14 weeks)

Procure-to-pay; lot/expiry depth; stocktake; full general ledger; AP; bank reconciliation;
budgets; fixed assets; financial close and management statements; margin/COGS reporting.

## Phase 4 — scale & ecosystem (8–12 weeks)

Multi-site; central analytics; public-health & FHIR interfaces; payer claims; payment
integration; patient self-service; advanced management pack.

## Phase 5 — optimisation (continuous)

Workflow refinement, decision support, forecasting and carefully governed AI assistance —
only after data-quality and clinical-safety maturity.

## Cross-cutting, every phase

Backward-compatible migrations with rollback; feature flags for staged release; traceability
register updated; definition of done (pack §26) enforced per feature: requirement +
acceptance evidence, UX states (loading/empty/offline/permission/error/conflict), server/DB
invariants, authorisation/audit/privacy/retention, local + cloud tested, migration +
rollback handled, tests pass, security + accessibility pass, monitoring + support docs,
recorded approvals, docs + traceability updated.
