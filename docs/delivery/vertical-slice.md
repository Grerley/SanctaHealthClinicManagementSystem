# First vertical slice & end-to-end acceptance test

Before broad module expansion, one complete path is built and demonstrated (prompt §11
step 3). It exercises identity, flow, clinical, medication, inventory, billing, finance,
audit, management and sync in a single thread — the smallest slice that proves the hard
parts (atomic local workflow + offline + convergent sync) rather than the easy ones.

## Slice path

```
patient search / registration
  → appointment or walk-in
  → check-in
  → triage (vitals)
  → clinical encounter (sign)
  → performed service or medicine (dispense)
  → charge
  → invoice
  → payment
  → receipt
  → stock + accounting entries
  → management exception + KPI
  → offline queue
  → cloud synchronisation
  → central management view
```

The slice must work on the clinic LAN **while disconnected from the internet** and
reconcile correctly after reconnection.

## Requirements exercised

PAT-001/002/003 · APT-001/002 (or VIS-001 walk-in) · VIS-002/003/006/008 ·
TRI-002/003/008 · EHR-001/003/007/008 · MED-001/002/005/006/007/008/010 ·
INV-001/002/005/006 · BIL-001/002/004/005/006/007/009/012 · FIN-002/004/010 ·
MGT-001/003 · SYN-001/002/003/004/005/006 · ADM-004 · CLD-001…005/011 ·
NFR-001/002/005/006/010/035.

## End-to-end acceptance test (maps to UAT-01, pack §22.1)

**Given** the clinic edge hub is provisioned and the internet is disconnected,
**and** a registered device with a provisioned cashier + clinician + nurse,

1. Register a **new synthetic walk-in** patient; the duplicate check runs against local
   records and finds none; a durable patient UUID + site MRN are issued offline (PAT-001/003).
2. Create a walk-in **visit**, issue a queue token, check in (PAT banner shows, no clinical
   leak to reception) (VIS-001/002/003).
3. Record **triage vitals**; an implausible value prompts confirmation, not silent rejection
   (TRI-002/003).
4. Clinician documents an **encounter** via a versioned form, saves a draft, the browser is
   force-closed and reopened → the draft recovers with **no duplicate encounter**; the
   encounter is **signed** and becomes immutable (EHR-003/007/008, NFR-002).
5. **Dispense** a medicine: FEFO lot selected; an expired lot is blocked; in one atomic
   local transaction the system writes medication history + stock movement + charge + COGS +
   audit + outbox (MED-007/008/010, INV-005/006, BR-008).
6. Cashier **finalises the invoice** (applied fee version retained), takes a **part-payment**
   in cash, allocates it, and prints a **receipt** locally (BIL-001/004/005/006/007, NFR-033).
7. **Cashier shift close** counts cash and reconciles; the remaining balance ages into the
   debtor subledger (BIL-008/009).
8. The **management view** shows the KPI move and raises the correct **exception** (e.g.
   outstanding balance / part-paid) linked to a work queue (MGT-001/003).
9. Throughout, all commits were **local-first**; the sync centre shows pending items with an
   idempotency key (SYN-002/003/005).
10. **Reconnect** the internet. The edge transmits the delta batch; the cloud validates and
    applies append-only events; the central PostgreSQL now holds the same patient, encounter,
    dispense, invoice, payment, stock movement and journals — **with no duplication** — and
    the central management view reconciles to the edge (SYN-004/006, CLD-003/004, NFR-010).
11. Re-run the sync (simulate duplicate delivery / retry) → **no duplicate** business
    transactions are created (idempotency, NFR-010).

**Pass criteria:** every ledger invariant holds (stock balance = Σ movements; journals
balance; invoice/stock/COGS reconcile to the dispense; ageing reconciles to control
account); no data lost across the browser/edge restart; `no-store` + read-after-write hold
on the cloud protected paths (NFR-035); the full path completed offline and reconciled after
reconnection.

## How it will be demonstrated

A scripted Playwright E2E run (with the network programmatically disabled then re-enabled)
plus a short recorded walkthrough on the target-class hardware, using **only synthetic
data**, with the traceability register rows for the above IDs moved to `verified` and
evidence linked from the MVP release-gate pack (pack §23.1).
