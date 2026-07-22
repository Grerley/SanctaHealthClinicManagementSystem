-- Clinical history, coded diagnoses & draft recovery on D1 (EHR-004/005/007, §7).
-- Structured status-tracked history; coded diagnoses with certainty + rank over an
-- offline-searchable synthetic code table; a patient's open draft encounter is
-- reused (never duplicated) so an interrupted form recovers on reconnect.

CREATE TABLE IF NOT EXISTS clinical_history_item (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES identity_patient(id),
  category    TEXT NOT NULL,      -- problem|past_medical|surgical|family|social|immunisation|allergy
  detail      TEXT NOT NULL,
  code        TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active|resolved|inactive
  onset_date  TEXT,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_history_item_patient_idx ON clinical_history_item (patient_id, category, recorded_at);

CREATE TABLE IF NOT EXISTS clinical_diagnosis_code (
  system  TEXT NOT NULL,
  code    TEXT NOT NULL,
  display TEXT NOT NULL,
  PRIMARY KEY (system, code)
);

CREATE TABLE IF NOT EXISTS clinical_diagnosis (
  id           TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL REFERENCES clinical_encounter(id),
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  code_system  TEXT,
  code         TEXT,
  display      TEXT,
  free_text    TEXT,
  certainty    TEXT NOT NULL DEFAULT 'confirmed',
  rank         INTEGER NOT NULL DEFAULT 1,
  recorded_by  TEXT,
  recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_diagnosis_encounter_idx ON clinical_diagnosis (encounter_id, rank);

-- A small SYNTHETIC diagnosis code set so search/record is exercisable offline.
INSERT OR IGNORE INTO clinical_diagnosis_code (system, code, display) VALUES
  ('SYNTHETIC-DX','A00','Cholera (synthetic)'),
  ('SYNTHETIC-DX','E11','Type 2 diabetes mellitus (synthetic)'),
  ('SYNTHETIC-DX','I10','Essential hypertension (synthetic)'),
  ('SYNTHETIC-DX','J06','Acute upper respiratory infection (synthetic)'),
  ('SYNTHETIC-DX','O80','Normal delivery (synthetic)'),
  ('SYNTHETIC-DX','Z00','General examination (synthetic)');
