# Cloudflare deployment map & clinic-edge boundary

Maps the Cloudflare account surface the connected plane needs, and states — precisely —
where the clinic edge boundary lies. Companion to ADR-0003.

## The one non-negotiable boundary

> **Cloudflare is the deployment target for the connected application plane, not the clinic
> offline server.** The clinic edge hub continues to authenticate authorised local users,
> save transactions, print, close the cashier and queue synchronisation when Cloudflare or
> the wider internet is unavailable (pack §15.2, NFR-038).

Everything below is *enhancement*. None of it may become a dependency for launch-core LAN
workflows.

## Account surface (version-controlled via Wrangler + Terraform — CLD-012, NFR-037)

| Surface | Environments | Notes |
|---------|--------------|-------|
| Workers Static Assets | dev / staging / prod | connected PWA + management portal shipped with the Worker as one release unit (CLD-001) |
| Worker (API / sync ingress / integration gateway) | dev / staging / prod | explicit routes, request schemas + limits; stateless (CLD-002) |
| Queues | per purpose: `sync-apply`, `notifications`, `reports`, `integrations` | each with retry ceiling, dead-letter queue, alerting, audited replay tool (CLD-003, NFR-036) |
| Hyperdrive | one **cache-disabled** binding for protected paths; optional cached binding for approved non-sensitive aggregates | (CLD-004, CLD-005, NFR-035) |
| R2 (private buckets) | `documents`, `reports`, `backups` | content hashes, lifecycle, approved location; independent recovery copy also kept (CLD-006) |
| Durable Objects | `site-sequence`, `entity-lock`, `sync-cursor`, `live-status` | bounded coordination only; never sole record (CLD-007) |
| Access | management portal, remote-support, admin APIs | deny-by-default, MFA, least privilege, service tokens, quarterly review (CLD-008) |
| WAF + rate limiting | all internet-facing routes | managed + custom API rules, upload restrictions, risk-based limits that still allow edge recovery after outage (CLD-009) |
| Tunnel | optional, outbound-only, support only | disable-72h test must pass (CLD-010, NFR-038) |
| Secrets | Workers Secrets / secret bindings; scoped API tokens | no secrets in source or build output (CLD-012) |

## Managed PostgreSQL

Canonical cloud relational store accessed from Workers **only** through Hyperdrive.
Requirements: transactions, constraints, point-in-time recovery, tested restore, cloud
backup RPO target 15 minutes (NFR-011), restore within 8 h for declared disaster (NFR-012).
Provider + region is a **blocking decision** (decisions-required).

## Data-flow & residency (must be documented and legally approved before production)

Trace and approve every place protected data can rest or transit: Workers request handling,
Hyperdrive→PostgreSQL, R2 objects, Queue message bodies, logs/traces/analytics, and
backups (NFR-032). Controls:

- `Cache-Control: no-store` on patient, clinical, finance, stock, session, admin responses
  (CLD-011, NFR-035).
- Exclude PHI, identifiers and message bodies from Cloudflare logs, traces, analytics and
  error reports (CLD-011, NFR-018).
- Encryption in transit (TLS 1.2+) and at rest (PostgreSQL, R2, backups) (NFR-015).
- Record hosting location, processors, subprocessors and transborder safeguards before data
  leaves Zimbabwe or another configured jurisdiction (NFR-032, pack §17 transborder).

## Cache-safety test obligations (NFR-035)

Automated tests must prove: (a) protected paths carry `no-store` and are not CDN-cached;
(b) the Hyperdrive binding on protected paths is cache-disabled; (c) read-after-write
correctness on patient/clinical/stock/billing/finance/auth/permission reads.

## Isolation test (NFR-038)

A scripted test disables Tunnel and simulates a full Cloudflare/internet outage for 72
hours and asserts all launch-core LAN workflows and queued local work continue unaffected.
