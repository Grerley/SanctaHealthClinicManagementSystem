-- ---------------------------------------------------------------------------
-- 0021 identity history & deceased provenance (PAT-007) + audit immutability
-- (NFR-016)
--
-- PAT-007: demographic changes are never destructive — each change is recorded
-- with its previous/new value and provenance (who, when, why), and death is
-- captured with a date and recorder, not just a boolean.
-- NFR-016: the audit log is append-only at the database level; UPDATE/DELETE are
-- refused by a trigger so tampering is impossible even with table access.
-- ---------------------------------------------------------------------------

CREATE TABLE identity.patient_identity_history (
  id          uuid PRIMARY KEY,
  patient_id  uuid NOT NULL REFERENCES identity.patient(id),
  field       text NOT NULL,               -- given_name | family_name | date_of_birth | sex | phone | deceased
  old_value   text,
  new_value   text,
  reason      text,
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_identity_history_idx ON identity.patient_identity_history (patient_id, changed_at);

ALTER TABLE identity.patient ADD COLUMN deceased_at date;
ALTER TABLE identity.patient ADD COLUMN deceased_recorded_by uuid;

-- Audit immutability (NFR-016, BR-012): append-only, enforced in the database.
CREATE OR REPLACE FUNCTION audit.block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_event is append-only (NFR-016, BR-012): % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.block_mutation();
