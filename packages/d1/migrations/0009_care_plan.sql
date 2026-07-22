-- Care plans, goals & follow-ups on D1 (EHR-006). A plan groups goals and dated
-- follow-ups; overdue open follow-ups surface on a work queue so care continues
-- between visits. Ported from the Postgres clinical schema. Dates are 'YYYY-MM-DD'
-- text, so due_date < asOf is a plain string comparison.

CREATE TABLE IF NOT EXISTS clinical_care_plan (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  encounter_id TEXT,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_care_plan_patient_idx ON clinical_care_plan (patient_id, status);

CREATE TABLE IF NOT EXISTS clinical_care_goal (
  id           TEXT PRIMARY KEY,
  care_plan_id TEXT NOT NULL REFERENCES clinical_care_plan(id),
  description  TEXT NOT NULL,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS clinical_care_followup (
  id           TEXT PRIMARY KEY,
  care_plan_id TEXT NOT NULL REFERENCES clinical_care_plan(id),
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  description  TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  completed_by TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS clinical_care_followup_due_idx ON clinical_care_followup (status, due_date);
