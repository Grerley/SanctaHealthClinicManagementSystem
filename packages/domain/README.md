# @sancta/domain

Framework-neutral domain logic and invariants shared by the clinic edge (Node.js) and the
Cloudflare cloud plane (Workers). **Zero runtime dependencies.** Every safety-critical rule
is unit-tested with Node's built-in test runner via type-stripping (`node --test
--experimental-strip-types`), so the suite runs with no build step and no test framework to
install.

## Modules

| Module | Responsibility | Key requirements |
|--------|----------------|------------------|
| `money` | integer minor-unit money; exact arithmetic; no floats | pack §8, BR-005/006 |
| `ids` | offline UUIDv7 (time-ordered) | PAT-001, BR-001 |
| `ledger` | double-entry batches; balance invariant; immutable reversal | FIN-002, BR-009 |
| `posting-rules` | §8.2 accounting events → balanced journals | FIN-002 |
| `stock` | balance = Σ immutable movements; negative-block; FEFO; expired/quarantined/recalled block | INV-005/006, MED-007/008, BR-007 |
| `idempotency` | outbox + idempotent apply with dependency ordering | SYN-003, NFR-010 |
| `state-machines` | encounter/invoice/appointment/visit/order lifecycles; signed-content append-only | pack §13.1, BR-003 |
| `duplicate-detection` | probabilistic patient matcher (never auto-merge) | PAT-003 |
| `pricebook` | effective-dated fees; override reason/approver rules | BIL-001/003, BR-005 |
| `ageing` | debtor ageing by as-of date; reconciles to control account | BIL-008 |

## Run

```bash
npm run test --workspace @sancta/domain   # unit tests (invariants)
npm run typecheck --workspace @sancta/domain
```

The `erasableSyntaxOnly` compiler flag guarantees the source stays compatible with Node's
type-stripping runtime (no enums, no parameter properties, no runtime-emitting syntax).
