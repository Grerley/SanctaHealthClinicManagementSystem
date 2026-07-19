# ADR-0000: Architecture decision record process

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** Engineering lead (proposed; awaiting product/clinical/finance/DPO ratification)

## Context

The pack (§11–§20, §26.1) requires material architectural choices to be recorded as ADRs
and requires any departure from its recommended baseline to be documented. Several choices
are also gated on decisions that only authorised owners can make
(see `docs/delivery/decisions-required.md`).

## Decision

We record each material decision as a numbered ADR in this directory. An ADR has: status
(Proposed / Accepted / Superseded / Rejected), date, deciders, context, decision,
consequences, and the requirement IDs it serves. ADRs are immutable once Accepted; changes
are new ADRs that supersede prior ones (mirrors the pack's no-silent-edit principle).

## Consequences

- Traceable rationale for every material choice.
- ADRs marked **Proposed** carry a conservative default and an owner who must ratify; work
  proceeds on the default and is revisited if the owner decides otherwise (pack §14: "state
  a conservative assumption, record it and continue" for non-blocking gaps).

## Index

| ADR | Title | Status |
|-----|-------|--------|
| 0001 | Offline-first modular monolith at edge and cloud | Proposed |
| 0002 | Technology baseline (TypeScript / React+Vite / PostgreSQL) | Proposed |
| 0003 | Cloudflare deployment topology | Proposed |
| 0004 | Outbox-based idempotent delta synchronisation | Proposed |
| 0005 | Append-only ledgers & entity-specific conflict policy | Proposed |
| 0006 | Identifiers, provenance & universal entity fields | Proposed |
