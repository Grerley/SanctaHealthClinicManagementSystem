# Blocking-decision sign-off pack

**Purpose.** Turn the open decisions (pack §25.1, `docs/delivery/decisions-required.md`) into
a document that named owners can *sign*. Each decision states the exact question, the
**recommended default** already adopted so engineering is not blocked, the options and their
consequences, and a sign-off block to record the owner's decision.

**How this works.**
- Engineering has **provisionally adopted the recommended default** for every decision so the
  Phase-1 build proceeds (prompt §14: "state a conservative assumption, record it and
  continue"). A signed decision either **confirms** the default or **overrides** it; an
  override becomes an ADR and a backlog change.
- **Production is blocked** until **B1 (jurisdiction/retention)** and **B2 (Cloudflare data
  boundary/residency)** are signed **Confirm/Override** — never launched on a default.
- Owners map to the governance roles in pack §24. Names are filled in by Sancta Health Clinic.

**Status key:** ⛔ blocks production · ⚙️ blocks the module that consumes it · ✅ default in use.

---

## Blocking decisions

### B1 — Jurisdiction, compliance & retention ⛔
**Owner:** Data protection owner + legal counsel
**Question:** Confirm regulator, data-controller licensing, statutory health-record retention
periods, and tax requirements (Zimbabwe baseline).
**Recommended default (in use):** Zimbabwe Cyber and Data Protection Act baseline; audit +
consent + disclosure implemented; retention periods **left configurable** pending legal input.
**Consequence if deferred:** schema/retention/audit remain on defaults; **no production**.
**Options:** (a) Confirm Zimbabwe baseline + supply retention periods · (b) Override with a
different jurisdiction/ruleset.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

### B2 — Cloudflare data boundary & residency ⛔
**Owner:** Data protection owner
**Question:** Legal approval for Workers processing, managed-PostgreSQL hosting, R2 object
location, logs and backups; list every processor/subprocessor and transborder safeguard
(NFR-032).
**Recommended default (in use):** all data movement is **documented** (see
`docs/cloudflare/deployment-map.md`); treated as **unapproved** (production blocked) until
signed; R2 location placeholder `WEUR` in Terraform pending approval.
**Consequence if deferred:** cannot lawfully move PHI to the cloud plane; **no production**.
**Options:** (a) Approve documented data map + region · (b) Restrict/relocate specific stores.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

### B3 — Hosting & support (managed PostgreSQL provider + region) ⚙️
**Owner:** Service owner
**Question:** Edge mini-PC spec; Cloudflare account/plan; **managed PostgreSQL provider +
region**; R2 location; backup destination; service hours; incident ownership.
**Recommended default (in use):** a managed PostgreSQL with point-in-time recovery in an
approved region; edge = supported low-power Linux mini-PC + UPS.
**Consequence if deferred:** Cloudflare IaC (Hyperdrive origin, R2 region) cannot be finalised.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

### B4 — Finance scope (own GL vs external accounting) ⚙️
**Owner:** Finance control owner
**Question:** Does the product own the full general ledger, or integrate to an external
accounting package? Define tax, payroll and statutory reporting depth.
**Recommended default (in use):** build the **full GL** (pack §7.12); keep a balanced,
idempotent accounting **export** (FIN-014) available for integration.
**Consequence if deferred:** finance module (Phase 3) direction unset; MVP posting rules are
already implemented and unaffected.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

### B5 — Clinical terminology & content ⚙️
**Owner:** Clinical safety owner
**Question:** Approved diagnosis coding system + version (ICD-10/11), formulary, protocols,
decision-support content, allergy/interaction content source.
**Recommended default (in use):** store code + display + system + **version** on every coded
item; ship allergy/interaction checks **only where validated content exists** (MED-003).
**Consequence if deferred:** EHR coding + medication safety content cannot be finalised for
Phase 2; no autonomous decision support is enabled regardless.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

### B6 — Identity policy ⚙️
**Owner:** Data steward
**Question:** MRN pattern, accepted identifiers, card/QR, duplicate threshold, cross-site
master-patient policy.
**Recommended default (in use):** UUIDv7 durable id + site MRN; configurable duplicate
threshold (matcher built, PAT-003); QR carries **no PHI**.
**Consequence if deferred:** MRN format + duplicate threshold stay on defaults; low risk.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

### B7 — Cloudflare identity & network ⚙️
**Owner:** Service owner + Data protection owner
**Question:** Identity provider for Access, MFA + device-posture policy, service-token
ownership, WAF + rate-limit policy, whether Tunnel is approved, break-glass administration.
**Recommended default (in use):** deny-by-default Access + MFA; Tunnel **disabled** unless
explicitly approved; WAF managed + custom API rules.
**Consequence if deferred:** remote management/support hardening (CLD-008/009/010) cannot be
finalised; does not affect LAN operation.
**Decision:** ☐ Confirm ☐ Override → __________________  **Owner:** __________  **Date:** ______

---

## Material decisions (needed by the phase that consumes them)

| # | Decision | Owner | Recommended default (in use) | Consumed by |
|---|----------|-------|------------------------------|-------------|
| M1 | Care model (services, roles, hours, emergency, outreach, FP/HIV/child) | Clinical safety + Product | Primary-care outpatient MVP; templates configurable | P1 forms; P2 templates |
| M2 | Volume & infrastructure (patients, visits/day, users, devices, power, LAN) | Service owner | NFR-009 scale targets (50 users, 250k patients, 2M encounters) | P0 sizing; perf tests |
| M3 | Payers (self-pay mix, sponsors, insurers, channels, currencies) | Finance control | Self-pay first; USD base; claims deferred to P4 (BIL-011) | P1 billing; P4 claims |
| M4 | Laboratory & pharmacy (internal vs referral, formulary, controlled meds, labels) | Clinical safety | Referral lab first; dispensing + FEFO built | P1 dispensing; P2 orders |
| M5 | Migration (source period, duplicate-review owner, opening-balance date, cut-over) | Data steward + Finance | 10-stage plan (pack §21); two rehearsals before cut-over | P1/P3 migration |
| M6 | Localisation (languages, formats, letterheads, consent forms, templates) | Product owner | British English, DD/MM/YYYY, USD base, local time zone (in use) | P1 i18n |
| M7 | Future roadmap (portal, outreach, multi-site, claims, public health, AI) | Product owner | Deferred per phased scope (pack §23) | P4/P5 |

---

## Summary status

| Decision | Blocks | Default in use | Signed? |
|----------|--------|----------------|---------|
| B1 Jurisdiction/retention | ⛔ production | ✅ | ☐ |
| B2 Cloudflare data boundary | ⛔ production | ✅ | ☐ |
| B3 Hosting / managed PostgreSQL | ⚙️ Cloudflare IaC | ✅ | ☐ |
| B4 Finance scope | ⚙️ Phase 3 finance | ✅ | ☐ |
| B5 Clinical terminology | ⚙️ Phase 2 EHR | ✅ | ☐ |
| B6 Identity policy | ⚙️ Phase 1 identity | ✅ | ☐ |
| B7 Cloudflare identity/network | ⚙️ remote mgmt | ✅ | ☐ |

**Bottom line for Sancta Health Clinic:** the build is progressing safely on documented,
conservative defaults; **assign owners and sign B1 + B2 before any production activation**,
and B3 before the Cloudflare infrastructure is provisioned for real. All seven map directly
to ADRs so a signed override changes exactly one recorded decision.
