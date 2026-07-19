# Proposed repository structure

A pnpm/npm workspace monorepo (ADR-0002): separate applications for clinic web, clinic
edge, cloud Worker and background consumers, over shared domain/contract packages. This is
the **target layout** for Phase 1; it is not yet scaffolded (Phase 0 is discovery only).

```
sancta-clinic-management-system/
├─ apps/
│  ├─ clinic-web/            # React + Vite PWA (served by edge offline; by Workers Static Assets online)
│  ├─ clinic-edge/           # Node.js local API + business-rule service, print/backup/health agents
│  ├─ cloud-worker/          # Cloudflare Worker: cloud API, sync ingress, integration gateway
│  └─ consumers/             # Cloudflare Queue consumers (sync apply, notifications, reports, integrations)
├─ packages/
│  ├─ domain/               # framework-neutral TS: entities, invariants, state machines, posting rules
│  ├─ db/                   # SQL migrations + query layer usable from Node.js and Workers/Hyperdrive
│  ├─ sync/                 # outbox/inbox, idempotency, conflict policy, checkpoints
│  ├─ auth/                 # RBAC + ABAC, device trust, break-glass, session
│  ├─ audit/               # tamper-evident audit events + provenance
│  ├─ contracts/            # OpenAPI specs, generated types, FHIR R4 adapter + capability statement
│  ├─ ui/                   # accessible component library (WCAG 2.2 AA), i18n (British English)
│  └─ config/               # effective-dated configuration + feature flags
├─ infra/
│  ├─ cloudflare/           # Wrangler + Terraform: routes, bindings, Queues, Hyperdrive, R2, Access, WAF, secrets
│  ├─ edge/                 # clinic-edge container image, install/upgrade/rollback/recovery scripts, UPS + backup
│  └─ db/                   # managed PostgreSQL provisioning, backup/PITR config
├─ migration/               # spreadsheet migration tools, staging schema, reconciliation, cut-over runbook
├─ docs/
│  ├─ requirements/         # traceability register, workbook traceability
│  ├─ architecture/         # ADRs, diagrams, data & sync design, this file
│  ├─ cloudflare/           # deployment map, data-flow & residency
│  ├─ delivery/             # implementation plan, risks, decisions-required, vertical slice
│  ├─ safety/               # clinical hazard log, safety case structure
│  ├─ security/             # threat model, ASVS control matrix, data-flow
│  └─ runbooks/             # ops, monitoring, incident, backup/restore
├─ tests/
│  ├─ e2e/                  # Playwright critical journeys + accessibility
│  ├─ integration/          # real PostgreSQL
│  ├─ contract/             # OpenAPI + FHIR profile
│  └─ resilience/           # 72 h outage, power loss, bulk reconnect, backup/restore
└─ .github/workflows/       # CI: lint, type-check, unit, integration, contract, security, e2e
```

## Domain isolation rule

The patient, clinical, billing, inventory, finance, audit and sync domains are separated in
code (`packages/domain` sub-modules) and schema (PostgreSQL schemas) with explicit
contracts, while preserving **atomic local workflows** (e.g. dispense spans clinical +
inventory + billing + finance in one edge transaction). Cross-domain writes go through a
single local transaction boundary, never through eventual consistency inside the edge.

## Test-as-product

Per pack §22, tests are part of each feature's definition of done. CI runs lint, type-check,
unit, integration (real PostgreSQL), contract, security and E2E on every change;
resilience/migration/performance suites run on a schedule and at release gates.
