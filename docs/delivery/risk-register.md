# Top risks & mitigations

Derived from pack §25 and the architecture. Ranked by exposure. Each risk has an owner
(assigned once the governance roles in pack §24 are staffed) and links to the controls that
mitigate it.

| # | Risk | Exposure | Mitigation | Owner |
|---|------|----------|------------|-------|
| 1 | **Clinical content not formally governed** (templates, alerts, protocols used without approval) | High | Appoint clinical safety owner; approve each template/alert/protocol version before use; hazard log + safety case gate MVP (NFR-029) | Clinical safety owner |
| 2 | **Identity errors during migration** (workbook per-row patient numbers ≠ unique people) | High | Durable patient ID distinct from visit/encounter; probabilistic duplicate detection; controlled reversible merge; preserve source; migration control totals (PAT-003/008, pack §21) | Data steward |
| 3 | **Offline conflicts create inconsistent records** | High | Entity-specific conflict policy (never generic LWW); append-only ledgers; idempotency; 72 h outage + concurrent-edit + bulk-reconnect tests (SYN-006, ADR-0005) | Engineering lead |
| 4 | **Cloudflare cache or logging exposes PHI** | High | `no-store` on protected responses; cache-disabled Hyperdrive; PHI excluded from logs/traces/analytics; header + read-after-write + log tests (CLD-005/011, NFR-035/018) | Data protection owner |
| 5 | **Cloudflare becomes a clinic availability dependency** | High | Serve clinic from local edge hub; 72 h isolation test; Tunnel optional/support-only; local commit is success condition (NFR-038, CLD-010) | Service owner |
| 6 | **Edge hardware or power failure** | High | UPS for hub/network/printer; supported mini-PC; auto-recovery without manual DB repair; local + cloud backup; spare device; restore rehearsal (NFR-031, NFR-011/012/013) | Service owner |
| 7 | **Financial integrity failure** (unbalanced journals, duplicate charges, editable totals, revenue/stock leakage) | High | Append-only ledgers; balances derived from movements; balanced immutable system journals; encounter-to-charge completeness; reconciliation exception reports; property-based invariant tests (FIN-002, BIL-002/012, BR-007/009, NFR-010) | Finance control owner |
| 8 | **Scope creep into an enterprise hospital system** | High | Phased boundaries + MVP gate; defer inpatient, imaging, claims, AI unless justified (pack §4.1, §23) | Product owner |
| 9 | **Inadequate security on shared devices** | High | Device management + unique users; rapid inactivity lock; privacy mode; restricted purpose-scoped cache; break-glass with review; routine access review (pack §17, NFR-017) | Data protection owner |
| 10 | **Regulatory / hosting / data-residency uncertainty (Zimbabwe)** | High | Legal review; DPIA; processor due diligence; documented + approved data movement across Workers/PostgreSQL/R2/logs/backups before production (NFR-032, pack §17 transborder) | Data protection owner |
| 11 | Weak adoption / parallel spreadsheet use | High | Co-design, super-users, cut-over policy, in-product controls, adoption metrics | Product owner |
| 12 | Integration instability (SMS, payment, lab, accounting export) | Medium | Queue + retry + idempotency + reconciliation; external failure never blocks core local transaction (SYN-010) | Engineering lead |
| 13 | Incomplete supplier/cost data undermines COGS & margin | Medium | Mandatory procurement evidence; master-data stewardship; exception queue (INV-004, FIN-005) | Data steward |

## Risk-review cadence

Reviewed at each phase gate and whenever an ADR is added. New material risks are added here
and, where they affect a decision, mirrored in `decisions-required.md`.
