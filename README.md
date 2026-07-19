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

Phase 0 (discovery) is complete and Phase 1 has begun with the **production foundation**:
a workspace monorepo, a fully tested safety-critical **domain package**, the DB schema
baseline, the Cloudflare Worker + clinic-edge skeletons, IaC stubs, CI and synthetic seed.
The first end-to-end vertical slice (`docs/delivery/vertical-slice.md`) is the next step and
begins in earnest once the blocking decisions in
[`docs/delivery/decisions-required.md`](docs/delivery/decisions-required.md) have owners.

### Build, typecheck and test

```bash
npm install        # links workspaces
npm run typecheck  # all workspaces
npm test           # 71 unit tests: ledger, stock/FEFO, idempotency, state machines, dispense, sync ingress
```

The domain package needs **no test framework and no build step** — tests run on Node's
built-in runner via type-stripping (`node --test --experimental-strip-types`).

### Foundation now in place

| Area | Location |
|------|----------|
| Tested domain invariants (money, ledger, stock/FEFO, idempotency, state machines, duplicate detection, pricing, ageing) | [`packages/domain/`](packages/domain/) |
| Canonical DB schema baseline (schemas, universal fields, append-only ledgers/audit/outbox) | [`packages/db/migrations/0001_init.sql`](packages/db/migrations/0001_init.sql) |
| Cloud Worker: API + sync ingress + `no-store` cache-safety | [`apps/cloud-worker/`](apps/cloud-worker/) |
| Clinic edge: local server + atomic dispense plan | [`apps/clinic-edge/`](apps/clinic-edge/) |
| Cloudflare IaC (Terraform) + `wrangler.toml` | [`infra/cloudflare/`](infra/cloudflare/), [`apps/cloud-worker/wrangler.toml`](apps/cloud-worker/wrangler.toml) |
| CI (lint · typecheck · test) | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
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
