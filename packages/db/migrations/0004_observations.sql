-- 0004_observations.sql — structured clinical observations / vitals (TRI-002,
-- EHR-002). Append-only; recorded against a visit's encounter. The flag captures
-- the plausible-range validation outcome at capture time.

BEGIN;

CREATE TABLE clinical.observation (
  id            uuid PRIMARY KEY,
  encounter_id  uuid REFERENCES clinical.encounter(id),
  patient_id    uuid NOT NULL REFERENCES identity.patient(id),
  kind          text NOT NULL,        -- temperature_c, systolic_bp, ...
  value         numeric NOT NULL,
  unit          text,
  flag          text NOT NULL,        -- ok | out_of_reference | implausible
  confirmed     boolean NOT NULL DEFAULT false,
  recorded_by   uuid,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observation_patient_idx ON clinical.observation (patient_id, recorded_at);
CREATE INDEX observation_encounter_idx ON clinical.observation (encounter_id);

COMMIT;
