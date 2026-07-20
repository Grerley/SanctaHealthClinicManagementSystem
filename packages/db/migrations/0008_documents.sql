-- 0008_documents.sql — document references + disclosure tracking (DOC-001/004/007).
-- Kept in the clinical schema for now. Documents are content-addressed by SHA-256;
-- unsafe uploads are quarantined and cannot be opened. Every disclosure of a
-- sensitive document is recorded.

BEGIN;

CREATE TABLE clinical.document_reference (
  id             uuid PRIMARY KEY,
  patient_id     uuid REFERENCES identity.patient(id),
  encounter_id   uuid REFERENCES clinical.encounter(id),
  doc_type       text NOT NULL,
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,
  security_label text NOT NULL DEFAULT 'normal',   -- normal | sensitive | restricted
  status         text NOT NULL DEFAULT 'available', -- available | quarantined
  quarantine_reason text,
  uploaded_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_patient_idx ON clinical.document_reference (patient_id);
CREATE INDEX document_hash_idx ON clinical.document_reference (sha256);

CREATE TABLE clinical.disclosure (
  id            uuid PRIMARY KEY,
  document_id   uuid NOT NULL REFERENCES clinical.document_reference(id),
  user_id       uuid NOT NULL,
  purpose       text,
  disclosed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disclosure_document_idx ON clinical.disclosure (document_id);

COMMIT;
