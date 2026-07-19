# ADR-0001: Offline-first modular monolith at edge and cloud

- **Status:** Proposed (default; ratify with Engineering lead + Service owner)
- **Date:** 2026-07-19
- **Serves:** NFR-001, NFR-002, NFR-003, NFR-038, SYN-001…SYN-008, pack §15

## Context

The clinic has intermittent internet and power. The pack mandates that launch-core
workflows remain fully usable on the clinic LAN for at least 72 hours without internet
(NFR-001) and that a cloud outage never stops core work (NFR-038). It also prefers "a
modular monolith with explicit domain boundaries over premature microservices" (prompt §4.3,
pack §15.1).

## Decision

1. **Two deployment planes, one codebase.** A **clinic edge hub** (mini-PC on the LAN) runs
   the local PWA, a local API/business-rule service, and a local PostgreSQL database, and is
   the operational system of record for launch-core work. A **Cloudflare cloud plane** runs
   the connected PWA/portal, cloud API, sync ingress and integrations against a canonical
   managed PostgreSQL.
2. **Modular monolith,** not microservices, on both planes. Domains — identity, clinical,
   billing, inventory, finance, audit, sync — are separated in code (packages/modules) and
   schema (PostgreSQL schemas) with explicit contracts, but deploy as one unit per plane.
3. **Local commit is the success condition** for core workflows. The UI never waits on the
   cloud to confirm a save (CHT/DHIS2 pattern).
4. **Shared domain logic** lives in framework-neutral TypeScript packages usable from both
   Node.js (edge) and Cloudflare Workers (cloud), so business rules are defined once.

## Consequences

- Edge and cloud run the same migrations and the same domain rules → convergent behaviour.
- Requires a query/runtime layer that works on both Node.js and Workers (see ADR-0002).
- Atomic local workflows (e.g. dispense = medication history + stock movement + charge +
  COGS in one transaction, BR-008) are preserved because a single edge database backs them.
- Operational simplicity suits constrained support capacity; domain boundaries keep the
  option of later extraction open.
