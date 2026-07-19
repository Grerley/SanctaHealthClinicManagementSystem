-- 0005_scheduling.sql — provider slots and appointments (APT-001/002/003/006).
-- A slot is a bookable window for a provider; an appointment occupies exactly one
-- slot. The UNIQUE(slot_id) on appointment plus a FOR UPDATE check at booking make
-- double-booking impossible (APT-001).

BEGIN;

CREATE TABLE scheduling.slot (
  id         uuid PRIMARY KEY,
  provider   uuid NOT NULL,
  site_id    uuid,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'open',   -- open | booked | blocked
  CHECK (ends_at > starts_at)
);
CREATE INDEX slot_provider_time_idx ON scheduling.slot (provider, starts_at) WHERE status = 'open';

CREATE TABLE scheduling.appointment (
  id           uuid PRIMARY KEY,
  slot_id      uuid NOT NULL UNIQUE REFERENCES scheduling.slot(id),
  patient_id   uuid NOT NULL REFERENCES identity.patient(id),
  service_code text,
  reason       text,                          -- sensitive; kept out of notifications (APT-009)
  status       text NOT NULL DEFAULT 'booked',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_patient_idx ON scheduling.appointment (patient_id);

COMMIT;
