-- 0015_charge_capture.sql — encounter-to-charge completeness (BIL-002/012, BR-004,
-- UAT-07). A billable completed encounter must have exactly one charge outcome:
-- charged, bundled, sponsor-funded, waived or non-billable (with an authorised
-- reason). A pending outcome on a signed billable encounter is a charge-capture gap.

BEGIN;

ALTER TABLE clinical.encounter ADD COLUMN billable boolean NOT NULL DEFAULT false;
ALTER TABLE clinical.encounter ADD COLUMN charge_status text NOT NULL DEFAULT 'pending';
  -- pending | charged | bundled | sponsor | waived | non_billable
ALTER TABLE clinical.encounter ADD COLUMN charge_invoice_id uuid REFERENCES billing.invoice(id);
ALTER TABLE clinical.encounter ADD COLUMN charge_exception_reason text;
ALTER TABLE clinical.encounter ADD COLUMN charge_exception_by uuid;

CREATE INDEX encounter_charge_gap_idx ON clinical.encounter (billable, charge_status)
  WHERE billable = true AND charge_status = 'pending';

COMMIT;
