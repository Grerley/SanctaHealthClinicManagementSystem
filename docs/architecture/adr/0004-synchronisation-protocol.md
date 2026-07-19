# ADR-0004: Outbox-based idempotent delta synchronisation

- **Status:** Proposed (default; ratify with Engineering lead)
- **Date:** 2026-07-19
- **Serves:** SYN-001…SYN-010, NFR-010, NFR-007, pack §15.4

## Context

Under unreliable connectivity the system must stay convergent without ever duplicating
clinical, stock or financial transactions, and without generic last-write-wins for
identity, signed clinical content, stock or finance (SYN-006, BR-015).

## Decision

Adopt the pack's 8-step outbox protocol (pack §15.4). For each locally committed
transaction the edge, in **one atomic local database transaction**, writes:

1. the domain change,
2. an **audit event**, and
3. an **outbox item** carrying: idempotency key, origin site, device, user, schema version,
   entity version, priority and dependency list.

A background sync engine then: transmits compressed delta batches over TLS with resumable
checkpoints and bounded exponential retry → the cloud validates device trust, user context,
schema, authorisation, idempotency and dependencies → applies the event (append-only) or
creates a **conflict case** → acknowledges only after the central transaction is durable →
the edge marks the outbox item synchronised → the edge pulls authorised deltas, config and
revocations since its last checkpoint.

Cloudflare Queues may process events **after** sync ingress, but the API returns a durable
receipt the edge reconciles against; queue retry/replay is idempotent (CLD-003).

## Consequences

- Idempotency key is the deduplication anchor end-to-end (outbox → Worker → Queue → DB).
- Pending / failed / conflicting work is surfaced to users and support queues (SYN-005).
- Clock drift is handled by storing both `captured_at` (device) and `received_at`
  (authoritative) and flagging drift beyond threshold without altering originals (SYN-007).
- Conflict handling is entity-specific — see ADR-0005.
