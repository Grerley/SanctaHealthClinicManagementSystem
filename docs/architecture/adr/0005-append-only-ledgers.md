# ADR-0005: Append-only ledgers & entity-specific conflict policy

- **Status:** Proposed (default; ratify with Finance control owner + Clinical safety owner)
- **Date:** 2026-07-19
- **Serves:** BR-003, BR-006…BR-011, BR-015, INV-005/006, BIL-010, FIN-002, SYN-006, pack §8, §13, §15.5

## Context

Identity, signed clinical content, payments, journals and stock movements must never use
generic last-write-wins and must be correctable only through controlled counter-transactions
(prompt §5, pack §8.1, §13.2).

## Decision

1. **Append-only, derive balances.** Stock balances are derived from immutable
   `StockMovement` rows (BR-007); patient/finance balances are derived from immutable
   payments, allocations and journal lines. No directly editable totals.
2. **No silent deletion.** Corrections use amendment / addendum / entered-in-error / void /
   reversal / credit note — each with reason, author, device, timestamp and (where required)
   approval. Originals stay visible to authorised reviewers (BR-003, BIL-010).
3. **Balanced, immutable system journals.** Every posting batch has equal debits and credits
   and a source reference (FIN-002); system-generated journals cannot be edited, only
   reversed and regenerated (BR-009). Manual journals require maker-checker (FIN-003, BR-011).
4. **Effective-dated configuration.** Price, fee, tax, discount and workflow versions are
   evaluated by effective date and the applied version is retained on the transaction
   (BR-005, BIL-001).
5. **Entity-specific conflict policy** (pack §15.5):

   | Entity | Conflict treatment |
   |--------|--------------------|
   | Patient demographics | field-level version compare; low-risk fields may merge; identity diffs → human review |
   | Appointment | optimistic lock; preserve both; flag overbooking; scheduling decision |
   | Draft clinical note | single active editor; concurrent drafts → labelled branches |
   | Signed clinical content | never merge/overwrite; addendum or entered-in-error only |
   | Payment / journal | append-only; duplicate idempotency key ignored; contradictory → reconciliation |
   | Stock movement | append-only; accept valid movements, recompute balance, exception on violation |
   | Configuration | centrally published version; local draft cannot become effective until approved |
   | Document | content-addressed immutable versions; concurrent updates → separate versions |

## Consequences

- Invariants are enforced in the **trusted server/database layer**, not the UI, and covered
  by property-based tests (NFR-010): balance = Σ movements, journals always balance,
  idempotent replay creates no duplicate event, ageing recomputes by as-of date.
- Segregation of duties (BR-011): a user cannot approve their own configured high-risk
  transaction.
