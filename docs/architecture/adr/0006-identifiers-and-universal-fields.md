# ADR-0006: Identifiers, provenance & universal entity fields

- **Status:** Proposed (default; ratify with Data steward)
- **Date:** 2026-07-19
- **Serves:** PAT-001, BR-001, BR-002, BR-014, SYN-003, SYN-007, pack §14.1

## Context

Records are created offline on many devices and must remain uniquely addressable and
mergeable after sync, with clear provenance and freshness.

## Decision

1. **UUIDv7 primary keys**, generable offline without central connectivity, giving
   roughly time-ordered identifiers for index locality. Human-readable numbers (MRN, visit
   number, invoice number, receipt number) are separate, controlled sequences.
2. **Durable patient identity is distinct and immutable** from visit and encounter numbers
   (BR-001). Date of birth is stored as a date; age is computed at event date and never the
   sole identity fact (BR-002).
3. **Receipt/invoice numbering offline** uses either non-overlapping reserved number blocks
   per device or UUID-backed provisional numbers reconciled to a fiscal sequence
   (pack §8.3).
4. **Universal entity fields** (pack §14.1) present on every business entity:

   | Group | Fields |
   |-------|--------|
   | Identity | `id` (UUIDv7), human-readable number where required |
   | Ownership | organisation, site, responsible service context |
   | Lifecycle | status, effective dates, created/updated/signed/approved times |
   | Provenance | creating user, device, source, imported-from ref, reason |
   | Versioning | entity version / ETag, schema version, content version |
   | Security | sensitivity label, purpose restrictions, consent ref, retention class |
   | Sync | local commit time, authoritative receive time, sync state, origin site |
   | Correction | voided/entered-in-error reason, superseding ref, authorisation |

## Consequences

- Data freshness can be shown wherever a record may lack unsynchronised changes from
  another site/device (BR-014, EHR-001 banner staleness indicator).
- Merge (PAT-008) preserves source identifiers, encounters and audit and is reversible.
- The universal-field set is implemented as a shared base schema/table mixin so every domain
  inherits provenance, versioning, security and sync metadata consistently.
