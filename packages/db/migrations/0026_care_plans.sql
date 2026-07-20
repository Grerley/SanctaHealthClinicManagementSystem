-- ---------------------------------------------------------------------------
-- 0026 care plans, goals & follow-ups (EHR-006)
--
-- A care plan carries goals and dated follow-ups; overdue follow-ups surface on
-- work queues so nothing is lost between visits.
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.care_plan (
  id           uuid PRIMARY KEY,
  patient_id   uuid NOT NULL REFERENCES identity.patient(id),
  encounter_id uuid REFERENCES clinical.encounter(id),
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'active', -- active | completed | cancelled
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_plan_patient_idx ON clinical.care_plan (patient_id, status);

CREATE TABLE clinical.care_goal (
  id            uuid PRIMARY KEY,
  care_plan_id  uuid NOT NULL REFERENCES clinical.care_plan(id),
  description   text NOT NULL,
  target_date   date,
  status        text NOT NULL DEFAULT 'open'  -- open | met | not_met
);

CREATE TABLE clinical.care_followup (
  id            uuid PRIMARY KEY,
  care_plan_id  uuid NOT NULL REFERENCES clinical.care_plan(id),
  patient_id    uuid NOT NULL REFERENCES identity.patient(id),
  description   text NOT NULL,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'open', -- open | done | cancelled
  completed_by  uuid,
  completed_at  timestamptz
);
CREATE INDEX care_followup_due_idx ON clinical.care_followup (status, due_date);
