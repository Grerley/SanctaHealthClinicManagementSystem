# Threat model & security-control matrix (structure)

Verified against applicable **OWASP ASVS 5.0 Level 2** controls (NFR-014, pack §17);
completed and pen-tested before the MVP security gate (pack §23.1). STRIDE per trust
boundary (see `docs/architecture/diagrams.md` boundaries A–D).

## Trust boundaries

- **A — Clinic LAN:** provisioned users + registered devices; device-bound offline
  re-auth; RBAC + ABAC deny-by-default; edge PostgreSQL encrypted at rest.
- **B — Public internet / Cloudflare edge:** WAF + rate limiting; Cloudflare Access + MFA.
- **C — Cloudflare Workers:** sync ingress validates device trust, user context, schema,
  authorisation, idempotency, dependencies.
- **D — Cloud data plane:** cache-disabled Hyperdrive → managed PostgreSQL; private R2.

## STRIDE summary (excerpt)

| Threat | Boundary | Control | Requirement |
|--------|----------|---------|-------------|
| Spoofing (stolen device) | A/C | registered-device trust, revocation, remote wipe, offline re-auth | ADM-002, UAT-14 |
| Tampering (edit signed note / ledger) | A/D | append-only signed content + ledgers; hash-chained audit | BR-003/009, NFR-016 |
| Repudiation | all | tamper-evident audit of view/create/amend/sign/approve/print/export/break-glass | BR-012, ADM-004 |
| Information disclosure (PHI in CDN/logs) | B/C/D | no-store on protected paths; PHI excluded from logs/traces/analytics; cache-disabled Hyperdrive | CLD-005/011, NFR-018/035 |
| Denial of service | B | WAF + risk-based rate limits that still let edge recover after outage | CLD-009 |
| Elevation of privilege | A/C | deny-by-default RBAC+ABAC; no clinical access via admin; segregation of duties | pack §5.1, BR-011 |
| Malware upload | C | file-type allow-list, size limit, malware scan, content hash, quarantine | DOC-004 |

## Control matrix

Tracked per ASVS 5.0 L2 chapter (auth, session, access control, validation, crypto,
error/logging, data protection, comms, malicious code, business logic, files, API). Each
control has: status, evidence link, owner. Exceptions are documented with compensating
controls (NFR-014). Dependency, secret, static, dynamic and container scanning run in CI.
