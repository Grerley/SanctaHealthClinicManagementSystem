# Blocking & material decisions requiring an authorised owner

Per the prompt (§14.9) and pack §25.1. Decisions marked **BLOCKING** materially affect safe
implementation and must have an owner before the relevant work starts. For non-blocking
gaps a conservative default is recorded (prompt §14) and revisited when the owner engages.

> **Ready to sign:** these decisions are elevated into an actionable owner sign-off sheet at
> [`../governance/decision-signoff-pack.md`](../governance/decision-signoff-pack.md) — each with
> the exact question, the recommended default already in use, options, and a signature block.
> Production is blocked until **B1** and **B2** are signed.

## Blocking (needed before / early in Phase 1)

| # | Decision | Owner | Why blocking | Conservative default until decided |
|---|----------|-------|--------------|-------------------------------------|
| B1 | **Jurisdiction & compliance** — regulator, data-controller licensing, health-record retention, tax requirements (Zimbabwe baseline) | Data protection owner + legal | Retention, consent, audit, tax and residency shape schema + controls | Zimbabwe Cyber & Data Protection Act baseline; retention TBD; **no production** until confirmed |
| B2 | **Cloudflare data boundary** — legal approval for Workers processing, PostgreSQL hosting, R2 location, logs, backups; list every processor/subprocessor/transborder safeguard | Data protection owner | NFR-032 gates production; PHI must not leave approved jurisdiction unlawfully | Document all data movement; treat as unapproved (block prod) until signed |
| B3 | **Hosting & support** — edge mini-PC spec, Cloudflare account/plan, **managed PostgreSQL provider + region**, R2 location, backup destination, service hours, incident ownership | Service owner | Provider/region choice drives IaC, residency, RPO/RTO | Assume a managed PostgreSQL with PITR in an approved region; confirm before IaC lands |
| B4 | **Finance scope** — does the product own the full general ledger or integrate to an external accounting package? tax, payroll, statutory reporting depth | Finance control owner | Determines whether FIN-001…FIN-012 are built vs exported (FIN-014) | Build full GL per pack §7.12; keep balanced idempotent export (FIN-014) available |
| B5 | **Clinical terminology & content** — approved diagnosis coding system + version (ICD-10/11), formulary, protocols, decision-support content, allergy/interaction content source | Clinical safety owner | EHR-005, MED-003 and safety behaviour depend on approved content | Store code+display+system+version; ship allergy/interaction checks only where validated content exists |
| B6 | **Identity policy** — MRN pattern, accepted identifiers, card/QR, duplicate threshold, cross-site master-patient policy | Data steward | PAT-001…003 and merge depend on it | UUIDv7 + site MRN; configurable duplicate threshold; QR carries no PHI |
| B7 | **Cloudflare identity & network** — IdP for Access, MFA + device-posture policy, service-token ownership, WAF + rate-limit policy, whether Tunnel is approved, break-glass admin | Service owner + Data protection owner | CLD-008/009/010 need concrete policy | Deny-by-default Access + MFA; Tunnel disabled unless explicitly approved |

## Material (needed by the phase that consumes them)

| # | Decision | Owner | Consumed by |
|---|----------|-------|-------------|
| M1 | **Care model** — services, clinical roles, hours, emergency handling, outreach, family planning, HIV, child health | Clinical safety owner + Product owner | P1 forms/workflows; P2 templates |
| M2 | **Volume & infrastructure** — patients, visits/day, users, sites, devices, printers, power, LAN, internet quality, physical security | Service owner | P0 architecture validation; NFR-009 scale |
| M3 | **Payers** — self-pay mix, employer/sponsor accounts, insurers, claims, currencies, payment channels | Finance control owner | P1 billing; P4 claims (BIL-011) |
| M4 | **Laboratory & pharmacy** — internal vs referral lab, medicine catalogue, controlled medicines, dispensing roles, label needs | Clinical safety owner | P1 dispensing; P2 orders |
| M5 | **Migration** — authoritative source period, duplicate-review owner, opening-balance date, cut-over window | Data steward + Finance control owner | P1/P3 migration + reconciliation |
| M6 | **Localisation** — languages, date/currency/number formats, letterheads, consent forms, message templates | Product owner | P1 i18n (British English default, DD/MM/YYYY, USD base) |
| M7 | **Future roadmap** — patient portal, mobile outreach, multi-site, payer claims, public-health reporting, AI appetite | Product owner | P4/P5 |

## Recorded defaults already applied (non-blocking)

- British English, DD/MM/YYYY, USD base currency, local time zone (NFR-020, pack §1 launch
  assumption).
- Technology baseline per ADR-0002 (no approved equivalent pre-existed in the repo).
- Offline-first modular monolith per ADR-0001; Cloudflare topology per ADR-0003.
- Single clinic at launch, multi-site ready (pack §1 launch assumption).
