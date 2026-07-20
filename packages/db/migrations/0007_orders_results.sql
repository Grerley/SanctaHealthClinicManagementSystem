-- 0007_orders_results.sql — orders, results and critical-result acknowledgement
-- (ORD-001/003/005/006, UAT-06). Kept in the clinical schema. Results are
-- append-only; critical results stay open until acknowledged.

BEGIN;

CREATE TABLE clinical.service_request (
  id            uuid PRIMARY KEY,
  patient_id    uuid NOT NULL REFERENCES identity.patient(id),
  encounter_id  uuid REFERENCES clinical.encounter(id),
  category      text NOT NULL,        -- laboratory | imaging | procedure | nursing | referral
  code          text NOT NULL,
  priority      text NOT NULL DEFAULT 'routine',
  indication    text,
  status        text NOT NULL DEFAULT 'active', -- draft|active|accepted|in_progress|completed|cancelled|declined|not_performed
  requested_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_request_patient_idx ON clinical.service_request (patient_id);
CREATE INDEX service_request_status_idx ON clinical.service_request (status);

CREATE TABLE clinical.result (
  id                  uuid PRIMARY KEY,
  service_request_id  uuid NOT NULL REFERENCES clinical.service_request(id),
  patient_id          uuid NOT NULL REFERENCES identity.patient(id),
  value               numeric NOT NULL,
  unit                text,
  ref_low             numeric,
  ref_high            numeric,
  abnormal            text NOT NULL DEFAULT 'normal', -- normal | low | high
  critical            boolean NOT NULL DEFAULT false,
  verified_by         uuid,
  released_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX result_open_critical_idx ON clinical.result (critical) WHERE critical = true;

CREATE TABLE clinical.critical_result_ack (
  id               uuid PRIMARY KEY,
  result_id        uuid NOT NULL UNIQUE REFERENCES clinical.result(id),
  acknowledged_by  uuid NOT NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  action           text
);

COMMIT;
