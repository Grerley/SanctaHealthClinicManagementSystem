-- Appointment lifecycle on D1 (APT-001..008): booking, waitlist, reminders and
-- versioned appointment types. Ported from the Postgres scheduling schema. The
-- Postgres slot lock (FOR UPDATE) becomes a PARTIAL UNIQUE INDEX on the active
-- appointment per slot: a concurrent double-book trips the unique constraint and
-- the batch rolls back — no double-booking without a lock.

CREATE UNIQUE INDEX IF NOT EXISTS scheduling_appointment_active_slot_uq
  ON scheduling_appointment (slot_id)
  WHERE status NOT IN ('cancelled','no_show','left_before_seen');

CREATE TABLE IF NOT EXISTS scheduling_waitlist (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  provider     TEXT NOT NULL,
  service_code TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open',
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS scheduling_waitlist_provider_idx ON scheduling_waitlist (provider, status);

CREATE TABLE IF NOT EXISTS scheduling_reminder (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES scheduling_appointment(id),
  kind           TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'sms',
  body           TEXT NOT NULL,
  send_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (appointment_id, kind)
);

CREATE TABLE IF NOT EXISTS scheduling_appointment_type (
  code           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  name           TEXT NOT NULL,
  duration_min   INTEGER NOT NULL CHECK (duration_min > 0),
  prep           TEXT,
  deposit_minor  INTEGER NOT NULL DEFAULT 0,
  changed_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (code, version)
);
