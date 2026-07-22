-- Structured clinical forms (EHR-003) + privacy disclosure log (PAT-010) on D1.
-- Forms are versioned, effective-dated reference data (a new version closes the
-- prior); an authorised patient-summary disclosure is recorded in an append-only
-- log so a patient can be told who saw their record and why. JSON schema as TEXT;
-- booleans INTEGER 0/1.

CREATE TABLE IF NOT EXISTS clinical_form_definition (
  form_code      TEXT NOT NULL,
  version        INTEGER NOT NULL,
  title          TEXT NOT NULL,
  schema         TEXT NOT NULL,        -- JSON array of FormField
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT,
  PRIMARY KEY (form_code, version)
);

CREATE TABLE IF NOT EXISTS clinical_patient_summary_disclosure (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES identity_patient(id),
  disclosed_by  TEXT,
  purpose       TEXT NOT NULL,
  recipient     TEXT,
  format        TEXT NOT NULL DEFAULT 'print',
  content_hash  TEXT NOT NULL,
  disclosed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_patient_summary_disclosure_idx ON clinical_patient_summary_disclosure (patient_id, disclosed_at);
