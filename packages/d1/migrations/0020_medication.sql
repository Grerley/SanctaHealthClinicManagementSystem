-- Formulary search, dispensing worklist & printed prescriptions on D1
-- (MED-001/005/006). Adds the dispense-tracking columns to medication requests and
-- a minimal staff registry for prescriber details on printed scripts. Ported from
-- the Postgres schema.

ALTER TABLE clinical_medication_request ADD COLUMN dispensed_at TEXT;
ALTER TABLE clinical_medication_request ADD COLUMN dispensed_by TEXT;

CREATE TABLE IF NOT EXISTS organisation_staff (
  id              TEXT PRIMARY KEY,
  full_name       TEXT NOT NULL,
  registration_no TEXT
);
