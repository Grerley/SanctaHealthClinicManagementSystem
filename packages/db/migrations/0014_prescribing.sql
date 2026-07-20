-- 0014_prescribing.sql — allergies and medication requests (MED-002/003, UAT-05).
-- Prescribing checks active allergies; a match blocks unless an authorised override
-- with a reason is recorded on the request.

BEGIN;

CREATE TABLE clinical.allergy (
  id             uuid PRIMARY KEY,
  patient_id     uuid NOT NULL REFERENCES identity.patient(id),
  substance_code text NOT NULL,
  severity       text NOT NULL DEFAULT 'high',  -- low | high | critical
  noted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX allergy_patient_idx ON clinical.allergy (patient_id);

CREATE TABLE clinical.medication_request (
  id              uuid PRIMARY KEY,
  patient_id      uuid NOT NULL REFERENCES identity.patient(id),
  encounter_id    uuid REFERENCES clinical.encounter(id),
  medicine_code   text NOT NULL,
  substance_code  text NOT NULL,
  dose            text,
  route           text,
  frequency       text,
  duration_days   integer,
  quantity        integer,
  status          text NOT NULL DEFAULT 'active',
  prescribed_by   uuid,
  override_reason text,
  override_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medication_request_patient_idx ON clinical.medication_request (patient_id);

COMMIT;
