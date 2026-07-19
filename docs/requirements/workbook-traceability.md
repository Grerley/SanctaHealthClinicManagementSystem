# Workbook-to-system traceability (pack Appendix B)

The legacy source is `SANCTA HEALTH CLINIC - FINANCIAL OPERATING MODEL.xlsx`. It is a
first-pass control framework, not a safe system of record. The system **replaces** it with
controlled source transactions and ledgers; it does not reproduce its screens.

> Migration principle (pack §3): import source transactions and master data only after
> profiling, cleaning, mapping and reconciliation. Recalculate balances, ageing, stock and
> statements **inside the new system**. Preserve the original workbook as an encrypted,
> read-only migration record. Never migrate formula outputs as authoritative transactions.

| Control objective | Workbook source | Target requirement IDs |
|-------------------|-----------------|------------------------|
| Prevent revenue leakage | INFO anti-leakage; Daily revenue variance; Cash Book | VIS-008, BIL-002, BIL-012, BIL-009, FIN-002, MGT-003 |
| Patient payment status | Patient register; Debtors Register | BIL-006, BIL-008, BIL-010, FIN-002 |
| Standard fees and limits | Fee Schedule | BIL-001, BIL-003, ADM-003 |
| Cash position and count | Cash Book; Dashboard | BIL-009, FIN-004, MGT-001, MGT-003 |
| Monthly P&L | Monthly P&L; Expenses | FIN-001 … FIN-012 |
| Break-even and recovery | Dashboard; Monthly P&L | FIN-012, MGT-004, MGT-005 |
| Drug stock | Drug stock register | INV-001, INV-002, INV-005, INV-006, INV-009 |
| Drug purchase and margin | Drug purchases | INV-003, INV-004, INV-011, FIN-011 |
| Consumables | Consumables | INV-001, INV-003 … INV-008 |
| Capital purchases | One-off purchases | INV-010, FIN-005, FIN-008 |
| Management oversight | Dashboard; user guide | MGT-001 … MGT-010, OPS-003, ADM-005 |
| Daily and monthly workflow | INFO checklists | OPS-003, OPS-004, BIL-009, FIN-009, FIN-010 |

## Known workbook data-quality findings to guard against on import (pack §3.2)

- **Identity:** 55 recorded encounters but the patient number increments per row; 47 unique
  non-blank name strings does not prove 47 unique people → durable patient identifier
  distinct from visit/encounter; probabilistic duplicate detection; controlled merge.
- **Completeness:** of 55 rows, 3 lack a name, 5 lack age, 33 lack phone, 23 lack provider
  → context-sensitive mandatory fields, unknown/declined reasons, completeness reporting.
- **Age/dates:** four ages exceed 120 and look like spreadsheet date serials; mixed numeric
  and text dates → store DOB as a date, calculate age, allow estimated-DOB flag, validate.
- **Vocabulary:** service labels vary by case/spelling/combined descriptions → controlled
  versioned catalogues with separate free-text notes.
- **Finance:** formula errors in daily revenue, cash-book linkage, break-even, capital →
  rebuild from transaction rules and journals; never migrate formula outputs.
- **Stock:** three drug rows with negative closing stock, one duplicated item, many
  purchases missing supplier/cost → append-only movements, batch identity, receiving
  controls, negative-stock prevention, required supplier evidence.
- **COGS:** P&L uses cumulative purchases, not period consumption → post purchases to stock,
  recognise COGS on dispense/issue via configured valuation.
- **Periods:** monthly P&L has no enforced period, mixes cumulative and monthly → explicit
  accounting periods with transaction/posting dates and close/reopen authorisation.
- **Audit/access:** spreadsheet editing lacks user-level approval, immutable history and
  purpose-based access → named users, least privilege, maker-checker, audit, reason codes,
  no destructive deletion.

Migration is delivered per the 10-stage plan in pack §21 with the acceptance controls in
§21.1 (100% source lineage; every rejected row has reason/owner/disposition; opening
balances reconcile to signed control totals; migrated clinical data visibly marked).
**No patient-level workbook data may enter source, fixtures, logs or non-production.**
