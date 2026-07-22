-- Orders, results and the critical-result acknowledgement workflow, plus external
-- results, corrections, order sets, specimens and outbound referrals on D1
-- (ORD-001..009, UAT-06). Ported from the Postgres clinical schema. Results are
-- append-only — a correction supersedes via a NEW row and retains the original.
-- encounter_id is plain TEXT (the encounters module owns clinical_encounter);
-- patient_id references identity_patient. Booleans are INTEGER 0/1, times ISO text.

CREATE TABLE IF NOT EXISTS clinical_service_request (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  encounter_id TEXT,
  category     TEXT NOT NULL,
  code         TEXT NOT NULL,
  priority     TEXT NOT NULL DEFAULT 'routine',
  indication   TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  requested_by TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_service_request_patient_idx ON clinical_service_request (patient_id);
CREATE INDEX IF NOT EXISTS clinical_service_request_status_idx ON clinical_service_request (status);

CREATE TABLE IF NOT EXISTS clinical_result (
  id                 TEXT PRIMARY KEY,
  service_request_id TEXT NOT NULL REFERENCES clinical_service_request(id),
  patient_id         TEXT NOT NULL REFERENCES identity_patient(id),
  value              REAL NOT NULL,
  unit               TEXT,
  ref_low            REAL,
  ref_high           REAL,
  abnormal           TEXT NOT NULL DEFAULT 'normal',
  critical           INTEGER NOT NULL DEFAULT 0,
  verified_by        TEXT,
  status             TEXT NOT NULL DEFAULT 'final',
  supersedes         TEXT,
  released_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_result_critical_idx ON clinical_result (critical);

CREATE TABLE IF NOT EXISTS clinical_critical_result_ack (
  id              TEXT PRIMARY KEY,
  result_id       TEXT NOT NULL UNIQUE REFERENCES clinical_result(id),
  acknowledged_by TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  action          TEXT
);

CREATE TABLE IF NOT EXISTS clinical_external_result (
  id                 TEXT PRIMARY KEY,
  order_ref          TEXT NOT NULL,
  patient_id         TEXT,
  value              REAL,
  unit               TEXT,
  abnormal           TEXT NOT NULL DEFAULT 'normal',
  source             TEXT,
  status             TEXT NOT NULL DEFAULT 'unmatched',
  service_request_id TEXT,
  received_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  reconciled_by      TEXT,
  reconciled_at      TEXT
);
CREATE INDEX IF NOT EXISTS clinical_external_result_status_idx ON clinical_external_result (status, received_at);

CREATE TABLE IF NOT EXISTS clinical_order_set (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS clinical_order_set_item (
  id         TEXT PRIMARY KEY,
  set_code   TEXT NOT NULL REFERENCES clinical_order_set(code),
  category   TEXT NOT NULL,
  code       TEXT NOT NULL,
  priority   TEXT NOT NULL DEFAULT 'routine',
  indication TEXT
);
CREATE INDEX IF NOT EXISTS clinical_order_set_item_set_idx ON clinical_order_set_item (set_code);

CREATE TABLE IF NOT EXISTS clinical_specimen (
  id                 TEXT PRIMARY KEY,
  accession          TEXT UNIQUE NOT NULL,
  accession_seq      INTEGER NOT NULL,
  service_request_id TEXT NOT NULL REFERENCES clinical_service_request(id),
  patient_id         TEXT NOT NULL REFERENCES identity_patient(id),
  collected_on       TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS clinical_referral (
  id                 TEXT PRIMARY KEY,
  service_request_id TEXT,
  patient_id         TEXT NOT NULL REFERENCES identity_patient(id),
  target_facility    TEXT NOT NULL,
  reason             TEXT,
  status             TEXT NOT NULL DEFAULT 'sent',
  feedback           TEXT,
  sent_by            TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_referral_status_idx ON clinical_referral (status);
