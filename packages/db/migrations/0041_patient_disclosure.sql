-- ---------------------------------------------------------------------------
-- 0041 Patient summary disclosure log (PAT-010)
--
-- Every authorised export/print of a patient summary is recorded here — who
-- disclosed it, the lawful purpose, and when. The log is append-only (an
-- immutability trigger on audit already covers audit_event; this is the
-- patient-facing disclosure register a clinic can show a patient on request).
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.patient_summary_disclosure (
  id            uuid PRIMARY KEY,
  patient_id    uuid NOT NULL REFERENCES identity.patient(id),
  disclosed_by  uuid,
  purpose       text NOT NULL,
  recipient     text,
  format        text NOT NULL DEFAULT 'print',
  content_hash  text NOT NULL,          -- hash of the exported summary (tamper-evidence)
  disclosed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_summary_disclosure_patient_idx ON clinical.patient_summary_disclosure (patient_id, disclosed_at DESC);
