-- ---------------------------------------------------------------------------
-- 0048 Patient self-service (COM-006, future)
--
-- A scoped self-service token authenticates a patient (distinct from staff RBAC)
-- so they can view their balance and appointments, request a booking and signal
-- an intent to pay. Self-service NEVER acts directly on the record: a booking
-- request and a payment intent are staff-confirmed, so the patient can initiate
-- but not self-authorise clinical or financial changes.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE flow.self_service_token (
  token       text PRIMARY KEY,
  patient_id  uuid NOT NULL REFERENCES identity.patient(id),
  expires_at  timestamptz NOT NULL,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX self_service_token_patient_idx ON flow.self_service_token (patient_id);

CREATE TABLE flow.booking_request (
  id             uuid PRIMARY KEY,
  patient_id     uuid NOT NULL REFERENCES identity.patient(id),
  provider       uuid,
  service_code   text,
  preferred_date date,
  note           text,
  status         text NOT NULL DEFAULT 'pending', -- pending|confirmed|declined
  appointment_id uuid REFERENCES scheduling.appointment(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
CREATE INDEX booking_request_open_idx ON flow.booking_request (status, created_at) WHERE status = 'pending';

CREATE TABLE flow.payment_intent (
  id           uuid PRIMARY KEY,
  patient_id   uuid NOT NULL REFERENCES identity.patient(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  method       text NOT NULL DEFAULT 'mobile',
  status       text NOT NULL DEFAULT 'pending', -- pending|reconciled|cancelled
  note         text,
  payment_id   uuid REFERENCES billing.payment(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_intent_open_idx ON flow.payment_intent (status, created_at) WHERE status = 'pending';

COMMIT;
