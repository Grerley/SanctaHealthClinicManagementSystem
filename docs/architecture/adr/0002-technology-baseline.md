# ADR-0002: Technology baseline

- **Status:** Proposed (default; ratify with Engineering lead)
- **Date:** 2026-07-19
- **Serves:** prompt §4.3, NFR-019, NFR-022, NFR-023, NFR-027, SYN-009, CLD-001…CLD-012

## Context

The prompt sets a recommended baseline "unless the existing repository already establishes
an approved equivalent." The repository is empty, so we adopt the baseline and record it.

## Decision

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Language | **TypeScript** across shared/domain/app packages | one domain model on edge + Workers; type-checked invariants |
| Web app | **React + Vite PWA** | accessible (WCAG 2.2 AA, NFR-019), installable, offline shell |
| Edge runtime | **Node.js (LTS)** in a container | local API + PostgreSQL + print/backup agents |
| Cloud runtime | **Cloudflare Workers** | ADR-0003 |
| Database | **PostgreSQL** at edge and cloud | relational constraints, transactions, PITR; identical engine both planes |
| Query/migrations | tool compatible with **Node.js and Workers** (e.g. a lightweight query builder + SQL migrations) driven through **Hyperdrive** on Workers, direct `pg` on edge | one migration set, two runtimes |
| API contract | **OpenAPI-first REST** + separate **FHIR R4 adapter** & capability statement | SYN-009, NFR-027, interoperability at the boundary |
| Monorepo | **pnpm workspaces** (or npm workspaces) | separate apps: clinic-web, clinic-edge, cloud-worker, consumers; shared packages |
| Tests | Vitest (unit), Playwright (E2E/accessibility), a property-testing lib (ledgers/idempotency), real PostgreSQL for integration | pack §22 |
| IaC | **Wrangler + Terraform** for Cloudflare + managed PostgreSQL | CLD-012, NFR-037 |
| Containers | reproducible **clinic-edge** image + install/upgrade/rollback scripts | pack §12, deliverables |

## Consequences

- The offline shell, service worker and local persistence must be designed so browser
  storage holds only **safe drafts and app state** — never an uncontrolled alternative
  clinical/finance ledger (the edge PostgreSQL is the ledger).
- A thin runtime-abstraction is needed so the same repository code opens a `pg` pool on the
  edge and a Hyperdrive-bound connection on Workers.
- FHIR is an adapter at the boundary; internal transactions keep domain-led schemas
  (pack §14) so accounting/inventory/offline integrity is not weakened by FHIR shapes.

## Departures from baseline

None material at this time. Any future departure is a new ADR (pack requirement).
