-- ---------------------------------------------------------------------------
-- 0038 Appointment waiting list, reminders & versioned types (APT-004/005/007)
--
--  * waitlist   — patients awaiting capacity; a released slot is filled by the
--                 highest-priority compatible entry (APT-004).
--  * reminder   — queued appointment reminders. UNIQUE(appointment_id, kind)
--                 makes enqueue idempotent so an offline-created reminder sends
--                 exactly once even if the create is replayed (APT-005).
--  * appointment_type — effective-dated appointment types (duration, prep,
--                 deposit), versioned like the rest of our config (APT-007).
-- ---------------------------------------------------------------------------

BEGIN;

-- A slot released by a cancellation/no-show must be re-bookable, but the original
-- row (now cancelled) still references it. Replace the total UNIQUE(slot_id) with a
-- partial one covering only *active* appointments: at most one live booking per
-- slot (preserving the APT-001 no-double-book guarantee) while allowing a fresh
-- appointment on a re-opened slot.
ALTER TABLE scheduling.appointment DROP CONSTRAINT appointment_slot_id_key;
CREATE UNIQUE INDEX appointment_active_slot_idx ON scheduling.appointment (slot_id)
  WHERE status NOT IN ('cancelled', 'no_show', 'left_before_seen');

CREATE TABLE scheduling.waitlist (
  id           uuid PRIMARY KEY,
  patient_id   uuid NOT NULL REFERENCES identity.patient(id),
  provider     uuid NOT NULL,
  service_code text,
  priority     integer NOT NULL DEFAULT 0,        -- higher = more urgent
  status       text NOT NULL DEFAULT 'open',      -- open | filled | cancelled
  reason       text,                              -- sensitive; never sent in notifications
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX waitlist_provider_open_idx ON scheduling.waitlist (provider, priority DESC, created_at) WHERE status = 'open';

CREATE TABLE scheduling.reminder (
  id             uuid PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES scheduling.appointment(id),
  kind           text NOT NULL,                   -- e.g. 'reminder-24h'
  channel        text NOT NULL DEFAULT 'sms',
  body           text NOT NULL,                   -- APT-009: no clinical reason
  send_at        timestamptz,
  status         text NOT NULL DEFAULT 'queued',  -- queued | sent | cancelled
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, kind)
);

CREATE TABLE scheduling.appointment_type (
  code          text NOT NULL,
  version       integer NOT NULL,
  effective_from date NOT NULL,
  effective_to  date,
  name          text NOT NULL,
  duration_min  integer NOT NULL,
  prep          text,
  deposit_minor bigint NOT NULL DEFAULT 0,
  changed_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, version),
  CHECK (duration_min > 0),
  CHECK (deposit_minor >= 0)
);

COMMIT;
