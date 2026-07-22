-- Patient identity depth on D1: related persons + restricted-record access
-- (PAT-005/009) and reversible patient merge (PAT-008). Adds merged_into to the
-- patient row (search excludes merged patients) and the merge audit trail so a
-- merge can be reversed exactly. Ported from the Postgres identity schema.

ALTER TABLE identity_patient ADD COLUMN merged_into TEXT;

CREATE TABLE IF NOT EXISTS identity_related_person (
  id                   TEXT PRIMARY KEY,
  patient_id           TEXT NOT NULL REFERENCES identity_patient(id),
  name                 TEXT NOT NULL,
  relationship         TEXT NOT NULL,
  is_guardian          INTEGER NOT NULL DEFAULT 0,
  is_emergency_contact INTEGER NOT NULL DEFAULT 0,
  phone                TEXT,
  household_id         TEXT,
  related_patient_id   TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS identity_related_person_patient_idx ON identity_related_person (patient_id);

CREATE TABLE IF NOT EXISTS identity_patient_merge (
  id           TEXT PRIMARY KEY,
  surviving_id TEXT NOT NULL,
  merged_id    TEXT NOT NULL,
  merged_by    TEXT,
  reversible   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS identity_merge_moved_record (
  id         TEXT PRIMARY KEY,
  merge_id   TEXT NOT NULL REFERENCES identity_patient_merge(id),
  table_name TEXT NOT NULL,
  record_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_merge_moved_record_merge_idx ON identity_merge_moved_record (merge_id);
