-- ---------------------------------------------------------------------------
-- 0023 triage assessment, danger signs & nursing interventions
-- (TRI-001/004/005/006/008)
--
-- The triage assessment captures the presenting reason, symptoms, pain and an
-- infection screen; danger signs and the early-warning score are computed from the
-- captured vitals and stored for visibility (decision support, never diagnosis).
-- Nursing interventions and the patient's response are recorded. Triage is signed
-- to hand off; an unsigned triage stays in the queue.
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.triage_assessment (
  id                uuid PRIMARY KEY,
  encounter_id      uuid NOT NULL REFERENCES clinical.encounter(id),
  patient_id        uuid NOT NULL REFERENCES identity.patient(id),
  reason            text,
  symptoms          jsonb NOT NULL DEFAULT '[]',
  pain_score        integer CHECK (pain_score IS NULL OR (pain_score BETWEEN 0 AND 10)),
  allergy_reviewed  boolean NOT NULL DEFAULT false,
  infection_screen  jsonb NOT NULL DEFAULT '{}',
  danger_signs      jsonb NOT NULL DEFAULT '[]',
  ews_score         integer,
  ews_band          text,
  ews_version       text,
  status            text NOT NULL DEFAULT 'draft',  -- draft | signed
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  signed_by         uuid,
  signed_at         timestamptz
);
CREATE UNIQUE INDEX triage_assessment_encounter_idx ON clinical.triage_assessment (encounter_id);

CREATE TABLE clinical.triage_intervention (
  id            uuid PRIMARY KEY,
  encounter_id  uuid NOT NULL REFERENCES clinical.encounter(id),
  patient_id    uuid NOT NULL REFERENCES identity.patient(id),
  kind          text NOT NULL,        -- positioning | oxygen | medication | wound_care | ...
  detail        text,
  medication    text,
  response      text,
  performed_by  uuid,
  performed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX triage_intervention_encounter_idx ON clinical.triage_intervention (encounter_id, performed_at);
