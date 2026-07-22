-- Patient identity history & deceased provenance on D1 (PAT-007, §6.1). A
-- demographic change never silently overwrites: the previous value, new value and
-- provenance (who, when, why) are kept in an immutable history and the live value
-- is updated with an incremented entity version. Death is captured with a date and
-- the recorder, not just a flag. Extends identity_patient (migrations 0002/0021).

ALTER TABLE identity_patient ADD COLUMN phone TEXT;
ALTER TABLE identity_patient ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE identity_patient ADD COLUMN updated_at TEXT;
ALTER TABLE identity_patient ADD COLUMN deceased_at TEXT;
ALTER TABLE identity_patient ADD COLUMN deceased_recorded_by TEXT;

CREATE TABLE IF NOT EXISTS identity_patient_identity_history (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES identity_patient(id),
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  reason     TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS identity_patient_identity_history_idx ON identity_patient_identity_history (patient_id, changed_at);
