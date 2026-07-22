-- Encounter-to-charge completeness on D1 (BIL-002/012, BR-004, UAT-07). Every
-- signed billable encounter must reach exactly one charge outcome — charged,
-- bundled, sponsor-funded, waived or non-billable — the last four only with an
-- authorised reason + approver. A signed billable encounter still 'pending' is a
-- charge-capture gap (revenue leakage) surfaced at day close. Extends
-- clinical_encounter (migration 0006); booleans are INTEGER 0/1.

ALTER TABLE clinical_encounter ADD COLUMN billable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clinical_encounter ADD COLUMN charge_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE clinical_encounter ADD COLUMN charge_invoice_id TEXT;
ALTER TABLE clinical_encounter ADD COLUMN charge_exception_reason TEXT;
ALTER TABLE clinical_encounter ADD COLUMN charge_exception_by TEXT;

CREATE INDEX IF NOT EXISTS clinical_encounter_charge_idx ON clinical_encounter (billable, status, charge_status);
