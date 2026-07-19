# Clinical hazard log (structure)

Authorised **clinical safety owner** maintains this log; it gates production
activation (NFR-029, pack §23.1). No production launch with an unresolved critical
patient-safety hazard. Structure below; hazards are added as workflows are designed
and reviewed with clinical governance.

| ID | Hazard | Cause | Clinical effect | Sev | Likelihood | Controls (design / process) | Residual | Owner | Status |
|----|--------|-------|-----------------|-----|-----------|-----------------------------|----------|-------|--------|
| HAZ-001 | Wrong-patient action | look-alike names, shared workstation | wrong record updated | High | — | persistent patient banner (EHR-001), confirm on look-alike (UX §12.1), positive ID on specimens (ORD-004) | — | Clinical safety | open |
| HAZ-002 | Allergy not surfaced | allergy not cached / stale offline data | harmful prescription/dispense | High | — | allergy in banner + stale-data flag (EHR-001), allergy check + controlled override (MED-003, UAT-05) | — | Clinical safety | open |
| HAZ-003 | Expired medicine dispensed | wrong lot picked | patient harm | High | — | FEFO + block expired/quarantined/recalled (MED-007/008, tested) | — | Clinical safety | open |
| HAZ-004 | Critical result not actioned | result released, no acknowledgement | delayed care | High | — | mandatory acknowledgement + timed escalation (ORD-006, UAT-06) | — | Clinical safety | open |
| HAZ-005 | Lost data on power/outage | edge crash before commit | missing clinical record | High | — | local-first durable commit before "saved" (SYN-002), power recovery (NFR-031), draft recovery (EHR-007) | — | Engineering | open |
| HAZ-006 | Silent alteration of signed note | edit of signed content | integrity/safety | High | — | append-only signed content (BR-003, tested), addendum/entered-in-error only | — | Clinical safety | open |

Each hazard links to the requirement(s) and test(s) that control it; residual risk is
signed off before the MVP patient-safety gate.
