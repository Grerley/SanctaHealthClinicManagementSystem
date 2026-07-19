# Canonical data & synchronisation design

Domain-led and FHIR-aligned where useful. FHIR is the interoperability contract at the
boundary, not a reason to weaken accounting, inventory or offline transaction integrity
inside the product (pack §14).

## Domain boundaries (PostgreSQL schemas / code modules)

| Domain | Core entities | FHIR alignment |
|--------|---------------|----------------|
| **identity** | Patient, PatientIdentifier, PersonName, Address, ContactPoint, RelatedPerson, GuardianAuthority, Consent, PatientMerge | Patient, RelatedPerson, Consent |
| **organisation** | Organisation, Site, Location, ServicePoint, Room, Device, Practitioner, PractitionerRole, StaffCredential | Organization, Location, Device, Practitioner, PractitionerRole |
| **scheduling** | Schedule, Slot, Appointment, AppointmentParticipant, WaitlistEntry, Reminder | Schedule, Slot, Appointment |
| **flow** | Visit, QueueEntry, CheckIn, ServiceStage, Handover | Encounter, Task |
| **clinical** | Encounter, ClinicalNote, FormResponse, Observation, Condition, Allergy, Procedure, CarePlan, Goal, FamilyHistory, Immunisation | Encounter, QuestionnaireResponse, Observation, Condition, AllergyIntolerance, Procedure, CarePlan, Goal, FamilyMemberHistory, Immunization |
| **orders** | ServiceRequest, Specimen, Result, DiagnosticReport, Referral, CriticalResultAcknowledgement | ServiceRequest, Specimen, Observation, DiagnosticReport, Task |
| **medication** | Medication, FormularyItem, MedicationRequest, MedicationDispense, MedicationAdministration, MedicationStatement | MedicationRequest/Dispense/Administration/Statement |
| **documents** | DocumentReference, BinaryObject, DocumentVersion, Disclosure, LegalHold | DocumentReference, Binary, Provenance |
| **billing** | PriceBook, ServiceItem, ChargeItem, Estimate, Invoice, InvoiceLine, PatientAccount, Payment, PaymentAllocation, Refund, CreditNote, DebtTask, Coverage, Claim | ChargeItem, Invoice, Account, Coverage, Claim, ExplanationOfBenefit |
| **inventory** | Product, SKU, UnitOfMeasure, Lot, StockLocation, StockMovement, StockBalanceView, Requisition, PurchaseOrder, GoodsReceipt, Stocktake, Supplier, Recall | SupplyRequest, SupplyDelivery |
| **finance** | ChartOfAccount, Account, JournalBatch, JournalEntry, JournalLine, FinancialPeriod, CostCentre, Budget, Forecast, BankAccount, BankStatement, Reconciliation, Expense, Payable, FixedAsset, DepreciationRun | product API + accounting export |
| **workflow** | Task, Checklist, Approval, Escalation, Notification, Message, Comment, Attachment | Task, Communication, CommunicationRequest |
| **security_sync** | User, Role, Permission, AccessPolicy, DeviceTrust, Session, AuditEvent, Provenance, ChangeEvent, OutboxItem, SyncCheckpoint, ConflictCase | AuditEvent, Provenance, security labels |
| **analytics** | KPIDefinition, Target, MetricFact, ManagementCommentary, Action, DataQualityIssue, ReportDefinition | Measure, MeasureReport |

Universal entity fields (identity, ownership, lifecycle, provenance, versioning, security,
sync, correction) are inherited by every entity — see ADR-0006.

## Core accounting events (double-entry, pack §8.2)

| Event | Debit | Credit | Source |
|-------|-------|--------|--------|
| Finalise patient invoice | Patient AR | Service / medicine revenue | encounter/dispense + invoice |
| Receive patient payment | Cash/bank/mobile clearing | Patient AR or deposit liability | payment + allocation |
| Receive inventory on credit | Inventory | Supplier AP | PO + GRN + supplier invoice |
| Dispense / consume stock | COGS or supplies expense | Inventory | dispense/issue movement |
| Pay operating expense | Expense or prepaid asset | Cash/bank/AP | approved expense + payment |
| Capital purchase | Fixed asset | Cash/bank/AP | approved asset receipt |
| Depreciation | Depreciation expense | Accumulated depreciation | asset schedule + close |
| Refund | Revenue reversal / refund liability | Cash/bank/patient AR | approved refund linked to receipt |
| Cash shortage | Cash over/short expense | Cash drawer | approved shift variance |
| Bad debt write-off | Bad debt expense/allowance | Patient AR | approved write-off |

Every financial report reconciles to these ledgers; no report relies on editable totals.

## Dispense atomic transaction (BR-008 worked example)

A single edge PostgreSQL transaction commits all of:

1. `MedicationDispense` (+ patient medication history),
2. `StockMovement` (FEFO lot decrement; blocked if expired/quarantined/recalled — MED-008),
3. `ChargeItem` → invoice line (or authorised zero-price/programme-funded exception),
4. `JournalBatch` (Dr COGS / Cr Inventory; Dr Patient AR / Cr Revenue),
5. `AuditEvent`,
6. `OutboxItem` (idempotency key + versions + dependencies).

If any step fails, the whole transaction rolls back — the user is only told "saved" after
the local commit succeeds (SYN-002).

## Synchronisation protocol (ADR-0004, pack §15.4)

```
local commit (atomic: domain + audit + outbox)
   → queue (idempotency key, origin, entity version, priority, deps)
   → transmit (compressed delta, TLS, resumable checkpoint, bounded retry)
   → cloud validate (device trust, user ctx, schema, authz, idempotency, deps)
   → apply (append-only / entity update via conflict policy) + central audit + ack
   → edge marks synced (only after durable central ack)
   → pull authorised deltas, config, revocations since checkpoint
   → reconcile (conflict / rejected → user-facing case)
```

Conflict policy is entity-specific (ADR-0005 / pack §15.5) — never generic last-write-wins
for identity, signed clinical, stock or finance.

## Offline capability matrix (pack §15.3)

- **Full offline:** patient search in cache, registration, appointment + local schedule,
  check-in + queue, triage, clinical note, local terminology, orders, prescriptions,
  dispensing, billing, payment, receipt, stock movement, cashier close, local reports,
  local audit.
- **Degraded but usable:** cross-site duplicate detection, uncached history, large
  attachments, central dashboard, terminology update, remote support, org-wide analytics —
  show staleness and queue work.
- **Online required:** device provisioning, first user activation, cloud identity recovery,
  external payment authorisation, insurer eligibility/claims, SMS delivery, central config
  publication, cross-site reconciliation.

## Invariants under test (NFR-010)

- stock balance = Σ immutable movements; negative stock blocked by default;
- journals always balance; system journals immutable (reverse + regenerate only);
- a payment reduces an invoice only once allocated; reallocation preserves history;
- idempotent replay creates no duplicate clinical/stock/financial event;
- signed clinical content is append-only; corrections are linked and attributable;
- ageing recomputes by as-of date and reconciles to the control account.
