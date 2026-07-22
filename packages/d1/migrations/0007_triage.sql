-- Triage / vitals capture on D1 (TRI-001..008, UAT-03). Observations keep the
-- entered value AND its plausibility flag (implausible values are confirmed, never
-- dropped). One assessment per encounter (UNIQUE encounter_id) with EWS + danger
-- signs computed from captured vitals. Ported from the Postgres clinical schema.
-- JSON fields (symptoms, infection_screen, danger_signs) stored as TEXT.

CREATE TABLE IF NOT EXISTS clinical_observation (
  id           TEXT PRIMARY KEY,
  encounter_id TEXT,
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  kind         TEXT NOT NULL,
  value        REAL NOT NULL,
  unit         TEXT,
  flag         TEXT NOT NULL,
  confirmed    INTEGER NOT NULL DEFAULT 0,
  recorded_by  TEXT,
  recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_observation_encounter_idx ON clinical_observation (encounter_id, recorded_at);
CREATE INDEX IF NOT EXISTS clinical_observation_patient_idx ON clinical_observation (patient_id, recorded_at);

CREATE TABLE IF NOT EXISTS clinical_triage_assessment (
  id               TEXT PRIMARY KEY,
  encounter_id     TEXT NOT NULL UNIQUE REFERENCES clinical_encounter(id),
  patient_id       TEXT NOT NULL REFERENCES identity_patient(id),
  reason           TEXT,
  symptoms         TEXT NOT NULL DEFAULT '[]',
  pain_score       INTEGER CHECK (pain_score IS NULL OR (pain_score BETWEEN 0 AND 10)),
  allergy_reviewed INTEGER NOT NULL DEFAULT 0,
  infection_screen TEXT NOT NULL DEFAULT '{}',
  danger_signs     TEXT NOT NULL DEFAULT '[]',
  ews_score        INTEGER,
  ews_band         TEXT,
  ews_version      TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  signed_by        TEXT,
  signed_at        TEXT
);

CREATE TABLE IF NOT EXISTS clinical_triage_intervention (
  id           TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL REFERENCES clinical_encounter(id),
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  kind         TEXT NOT NULL,
  detail       TEXT,
  medication   TEXT,
  response     TEXT,
  performed_by TEXT,
  performed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_triage_intervention_enc_idx ON clinical_triage_intervention (encounter_id, performed_at);
