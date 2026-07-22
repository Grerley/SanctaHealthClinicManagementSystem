-- Visit flow (queue board) and appointment scheduling on D1 — the tables behind
-- the Queue and Calendar screens (VIS-001/003, APT-001/008). Ported from the
-- Postgres edge schema (flow.*, scheduling.*) to flat D1 table names. Times are
-- stored as ISO-8601 UTC text ('YYYY-MM-DDTHH:MM:SSZ'); the day is derived with
-- substr(...,1,10), so string ordering == chronological ordering.

-- A patient visit (check-in → complete).
CREATE TABLE IF NOT EXISTS flow_visit (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  visit_number TEXT,
  site_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  completed_at TEXT
);

-- The cross-device queue board. One entry per visit; token is a running number.
CREATE TABLE IF NOT EXISTS flow_queue_entry (
  id         TEXT PRIMARY KEY,
  visit_id   TEXT NOT NULL REFERENCES flow_visit(id),
  token      INTEGER NOT NULL,
  station    TEXT NOT NULL DEFAULT 'reception',
  priority   INTEGER NOT NULL DEFAULT 100,
  status     TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS flow_queue_entry_station_idx ON flow_queue_entry (station, status, priority, token);

-- A bookable appointment slot.
CREATE TABLE IF NOT EXISTS scheduling_slot (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  site_id      TEXT,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  room         TEXT,
  service_code TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS scheduling_slot_starts_idx ON scheduling_slot (starts_at, provider);

-- A booking of a patient into a slot (calendar shows the patient MRN via this).
CREATE TABLE IF NOT EXISTS scheduling_appointment (
  id           TEXT PRIMARY KEY,
  slot_id      TEXT NOT NULL REFERENCES scheduling_slot(id),
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  service_code TEXT,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'booked',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS scheduling_appointment_slot_idx ON scheduling_appointment (slot_id);
