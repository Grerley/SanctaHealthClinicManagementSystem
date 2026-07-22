-- Clinical encounters + addenda on D1 (EHR-008/009, BR-003, UAT-04). A signed
-- encounter is immutable: it can only receive a linked addendum or be marked
-- entered-in-error. Ported from the Postgres clinical schema. `content` is JSON
-- stored as TEXT. form_code/form_version are nullable; form-validated signing is
-- wired when the forms module is ported (until then form_code stays NULL).

CREATE TABLE IF NOT EXISTS clinical_encounter (
  id             TEXT PRIMARY KEY,
  visit_id       TEXT NOT NULL,
  patient_id     TEXT NOT NULL REFERENCES identity_patient(id),
  status         TEXT NOT NULL DEFAULT 'draft',
  form_code      TEXT,
  form_version   INTEGER,
  signed_by      TEXT,
  signed_at      TEXT,
  content        TEXT NOT NULL DEFAULT '{}',
  entity_version INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_encounter_patient_idx ON clinical_encounter (patient_id);
CREATE INDEX IF NOT EXISTS clinical_encounter_visit_idx ON clinical_encounter (visit_id);

CREATE TABLE IF NOT EXISTS clinical_encounter_addendum (
  id           TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL REFERENCES clinical_encounter(id),
  author       TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_encounter_addendum_enc_idx ON clinical_encounter_addendum (encounter_id);
