-- 0013_patient_merge.sql — reversible patient merge support (PAT-008). The merged
-- patient row is preserved (never deleted) and marked with merged_into. Every
-- record repointed to the survivor is logged so the merge can be reversed exactly.

BEGIN;

ALTER TABLE identity.patient ADD COLUMN merged_into uuid REFERENCES identity.patient(id);

CREATE TABLE identity.merge_moved_record (
  id          uuid PRIMARY KEY,
  merge_id    uuid NOT NULL REFERENCES identity.patient_merge(id),
  table_name  text NOT NULL,
  record_id   uuid NOT NULL
);
CREATE INDEX merge_moved_merge_idx ON identity.merge_moved_record (merge_id);

COMMIT;
