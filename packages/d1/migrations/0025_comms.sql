-- Patient communication on D1 (COM-001..005). Consent/preference is checked before
-- a message is created (a non-consented message is recorded suppressed, never
-- sent); a UNIQUE dedup key means an offline-created message sends exactly once;
-- inbound replies raise a follow-up task. Ported from the Postgres flow schema.

CREATE TABLE IF NOT EXISTS flow_communication_preference (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  allowed    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (patient_id, purpose, channel)
);

CREATE TABLE IF NOT EXISTS flow_message (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  template   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',
  dedup_key  TEXT UNIQUE,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS flow_inbound_message (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT,
  channel     TEXT NOT NULL DEFAULT 'sms',
  body        TEXT NOT NULL,
  in_reply_to TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS flow_comms_task (
  id            TEXT PRIMARY KEY,
  inbound_id    TEXT NOT NULL REFERENCES flow_inbound_message(id),
  patient_id    TEXT,
  summary       TEXT NOT NULL,
  assigned_role TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  closed_at     TEXT,
  closed_by     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS flow_comms_task_status_idx ON flow_comms_task (status, created_at);
