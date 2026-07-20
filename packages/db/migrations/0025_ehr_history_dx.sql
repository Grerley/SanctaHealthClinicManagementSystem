-- ---------------------------------------------------------------------------
-- 0025 clinical history, coded diagnoses & draft recovery (EHR-004/005/007)
--
-- EHR-004: problem list, past medical/surgical/family/social history,
-- immunisations and allergies as structured, status-tracked items.
-- EHR-005: coded diagnoses with certainty, rank and free-text; an offline-
-- searchable code table. The APPROVED code system + version is decision B5 — this
-- table is configurable reference data; a small synthetic set seeds non-prod.
-- EHR-007: drafts recover to the SAME open encounter so a reconnecting client
-- never creates a duplicate.
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.history_item (
  id           uuid PRIMARY KEY,
  patient_id   uuid NOT NULL REFERENCES identity.patient(id),
  category     text NOT NULL,   -- problem | past_medical | surgical | family | social | immunisation | allergy
  detail       text NOT NULL,
  code         text,
  onset_date   date,
  status       text NOT NULL DEFAULT 'active', -- active | resolved | inactive
  recorded_by  uuid,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_item_patient_idx ON clinical.history_item (patient_id, category);

CREATE TABLE clinical.diagnosis_code (
  system   text NOT NULL,       -- approved system + version is B5
  code     text NOT NULL,
  display  text NOT NULL,
  PRIMARY KEY (system, code)
);
CREATE INDEX diagnosis_code_search_idx ON clinical.diagnosis_code (display text_pattern_ops);

CREATE TABLE clinical.diagnosis (
  id           uuid PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES clinical.encounter(id),
  patient_id   uuid NOT NULL REFERENCES identity.patient(id),
  code_system  text,
  code         text,
  display      text,
  free_text    text,
  certainty    text NOT NULL DEFAULT 'confirmed', -- suspected | provisional | confirmed
  rank         integer NOT NULL DEFAULT 1,        -- 1 = primary
  recorded_by  uuid,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX diagnosis_encounter_idx ON clinical.diagnosis (encounter_id, rank);
