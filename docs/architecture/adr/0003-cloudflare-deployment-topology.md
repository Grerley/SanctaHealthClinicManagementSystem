# ADR-0003: Cloudflare deployment topology

- **Status:** Proposed (default; ratify with Service owner + Data protection owner)
- **Date:** 2026-07-19
- **Serves:** CLD-001…CLD-012, NFR-032, NFR-035, NFR-036, NFR-037, NFR-038, pack §15.2

## Context

The connected application plane deploys to Cloudflare using current supported patterns.
Cloudflare must not become a clinic availability dependency, and protected health
information (PHI), identifiers and financial payloads must never enter Cloudflare logs,
traces, analytics or caches.

## Decision

| Cloudflare component | Use | Boundary / control |
|----------------------|-----|--------------------|
| **Workers Static Assets** | host connected PWA + management portal with the Worker as one release unit | **not** the deprecated Workers Sites pattern (CLD-001) |
| **Workers** | cloud API, sync ingress, integration gateway; stateless handlers | explicit routes, schemas, request limits (CLD-002) |
| **Queues** | async sync application, notifications, reports, integrations | bounded retry, dead-letter queues, audited idempotent replay (CLD-003, NFR-036) |
| **Managed PostgreSQL + Hyperdrive** | canonical cloud relational store | **caching disabled** for auth, permissions, patient, clinical, stock, billing, finance and any read needing freshness (CLD-004, CLD-005, NFR-035) |
| **R2 (private)** | documents, generated reports, encrypted backup artefacts | content hashes, lifecycle, approved location; not the only recovery copy (CLD-006) |
| **Durable Objects** | bounded coordination only: site sequencing, short-lived lock, sync cursor, live status | never the sole system of record for notes/payments/journals/stock (CLD-007) |
| **Access** | protect management + remote-support surfaces | deny-by-default, MFA, least privilege, logged service auth, quarterly review (CLD-008) |
| **WAF + rate limiting** | internet-facing routes | managed + custom rules, upload limits, risk-based limits that still let edge devices recover after outage (CLD-009) |
| **Tunnel** | optional outbound-only remote support to the edge | never required for LAN ops; disable-72h test (CLD-010, NFR-038) |
| **Secrets / tokens** | Workers Secrets, scoped API tokens | no secrets in source or build output (CLD-012) |

Additional standing controls:

- `Cache-Control: no-store` on all protected dynamic responses; PHI/identifiers/message
  bodies excluded from Cloudflare logs, traces, analytics, error reports (CLD-011, NFR-018).
- Version-controlled Wrangler + Terraform; separate dev/staging/prod; reproducible from
  code (CLD-012, NFR-037).
- Do **not** expose clinic PostgreSQL or the edge API to the public internet.

## Consequences

- A cache-disabled Hyperdrive binding is used on every protected path; a separate cached
  binding may serve only explicitly approved non-sensitive aggregates that tolerate
  staleness.
- Data-residency (NFR-032) must be documented and legally approved **before** production;
  this is a blocking decision (see decisions-required).
- Queue consumers are idempotent so replay/retry never duplicates clinical, stock or
  financial events (CLD-003, NFR-010).
