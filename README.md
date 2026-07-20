# Sancta Clinic Management System

Offline-first electronic medical record, clinic operations, financial management and
management-oversight platform for a low-resource outpatient clinic with intermittent
internet and power.

> **Product promise.** Every patient interaction becomes one safe, longitudinal
> clinical record and one complete, auditable operational and financial transaction —
> whether the internet is available or not.

This repository is being built against the authoritative
**Sancta Clinic Management System — Product Development Pack v1.0** (the *pack*). The pack
is the single source of truth for scope, workflows, requirements, data model, controls,
architecture and release gates. Where this repository and the pack conflict, the pack wins
unless an authorised product decision overrides it (recorded in an ADR).

## Current status — Phase 1 (production foundation, in progress)

Phase 0 (discovery) is complete and Phase 1 (operational MVP) is well under way. The
offline-first vertical slice is proven end-to-end, and modules across all 17 areas of the
pack are built with real code and tests. **Backlog coverage: ~42% of functional requirements
(weighted), ~77% of business rules, ~25% of measurable NFRs** — run `npm run coverage` for the
live figure ([`docs/requirements/COVERAGE.md`](docs/requirements/COVERAGE.md)). Production
activation remains gated on the blocking decisions in
[`docs/governance/decision-signoff-pack.md`](docs/governance/decision-signoff-pack.md).

### Build, typecheck and test

```bash
npm install          # links workspaces
npm run typecheck    # all workspaces
npm test             # unit tests (domain invariants, sync, worker) — no DB needed
npm run coverage     # backlog coverage dashboard

# Integration + E2E need a local PostgreSQL 16 (role `sancta`, port 5433):
DATABASE_URL=postgres://sancta@127.0.0.1:5433/sancta_test \
CLOUD_DATABASE_URL=postgres://sancta@127.0.0.1:5433/sancta_test \
  npm run test:integration -w @sancta/clinic-edge      # ~79 tests on real PostgreSQL
```

Tests run on Node's built-in runner via type-stripping — **no test framework, no build step**.
The current suite is **102 unit + 79 integration (real PostgreSQL) + 3 Playwright E2E**, all
green; see [`docs/delivery/verification-evidence.md`](docs/delivery/verification-evidence.md).

### Built and tested MVP modules

Patient registration/search/duplicate-check · triage vitals + range validation · clinical
encounter sign/addendum/entered-in-error · orders + results + critical-result acknowledgement ·
appointment scheduling (no double-book) · visit check-in/queue/completion-validation ·
atomic dispense→invoice→payment · payment allocation/reallocation · refunds · cashier shift
close · debtor ageing · financial period close/reopen · trial balance + income statement ·
goods receipt · stock alerts · stocktake · expenses + accounts payable · management command
centre (KPIs + exceptions) · patient communication (consent suppression) · operations
(staff credentials + task escalation) · document upload validation + disclosure · audit
search + audited export · edge↔cloud sync · offline resilience.

### Foundation

| Area | Location |
|------|----------|
| Tested domain invariants (money, ledger, stock/FEFO, idempotency, state machines, dupes, pricing, ageing, cashier, vitals, results, documents) | [`packages/domain/`](packages/domain/) |
| DB schema + forward migrations (0001–0012) | [`packages/db/`](packages/db/) |
| Clinic edge: local API + all MVP module logic | [`apps/clinic-edge/`](apps/clinic-edge/) |
| Cloud Worker + durable sync apply + `no-store` cache-safety | [`apps/cloud-worker/`](apps/cloud-worker/) |
| Offline-first PWA (React + Vite) | [`apps/clinic-web/`](apps/clinic-web/) |
| Cloudflare IaC + `wrangler.toml` | [`infra/cloudflare/`](infra/cloudflare/), [`apps/cloud-worker/wrangler.toml`](apps/cloud-worker/wrangler.toml) |
| CI (lint · typecheck · unit · integration · e2e) | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Synthetic seed data (no PHI) | [`seed/synthetic-seed.sql`](seed/synthetic-seed.sql) |

### Discovery deliverables (Phase 0)

| Area | Document |
|------|----------|
| Requirement inventory + traceability | [`docs/requirements/traceability-register.md`](docs/requirements/traceability-register.md) |
| Architecture decision records | [`docs/architecture/adr/`](docs/architecture/adr/) |
| Context, deployment & trust-boundary diagrams | [`docs/architecture/diagrams.md`](docs/architecture/diagrams.md) |
| Canonical data & synchronisation design | [`docs/architecture/data-and-sync-design.md`](docs/architecture/data-and-sync-design.md) |
| Cloudflare deployment map & edge boundary | [`docs/cloudflare/deployment-map.md`](docs/cloudflare/deployment-map.md) |
| First vertical slice + E2E acceptance test | [`docs/delivery/vertical-slice.md`](docs/delivery/vertical-slice.md) |
| Phased implementation plan | [`docs/delivery/implementation-plan.md`](docs/delivery/implementation-plan.md) |
| Top risks & mitigations | [`docs/delivery/risk-register.md`](docs/delivery/risk-register.md) |
| Blocking decisions needing an owner | [`docs/delivery/decisions-required.md`](docs/delivery/decisions-required.md) |
| Proposed monorepo layout | [`docs/architecture/repository-structure.md`](docs/architecture/repository-structure.md) |

## Planned architecture (summary)

Offline-first hybrid: a **clinic edge hub** (mini-PC on the clinic LAN) is the operational
system of record for launch-core work and continues to serve all clinic devices for at
least 72 hours without internet. A **Cloudflare-connected cloud plane** provides the
canonical central store, management portal, synchronisation ingress and integrations.
Cloudflare and the wider internet *enhance* the service; their absence must never stop
authorised work on the clinic LAN.

See the ADRs and diagrams for detail.

## Safety, privacy and data handling

- **Never** copy patient-level data from the source workbook into source code, fixtures,
  logs, screenshots or non-production environments. Use clearly synthetic data only.
- No secrets in source or build artefacts.
- Decision support assists an authorised clinician; it is never an autonomous decision-maker.
- Zimbabwean legal, health-record, tax, retention and transborder requirements must be
  confirmed with authorised local advisers before production. This repository is not a
  substitute for legal or clinical approval.

## Contributing / branch policy

Active development branch: `claude/sancta-clinic-system-n4krfb`.
Every change traces to a requirement ID from the pack and to a test before it is marked done
(see the definition of done in pack §26 and the traceability register).
