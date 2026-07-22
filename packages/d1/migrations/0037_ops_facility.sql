-- Clinic operations, device trust & facility on D1 (OPS-001..007, ADM-002).
-- Staff credentials that can gate clinical actions; tasks with owner/priority/due;
-- device trust + revocation; facility resources with capacity/status; operational
-- checklists with completion enforcement; incident capture with corrective action;
-- equipment maintenance/calibration scheduling. Booleans INTEGER 0/1; JSON as TEXT.

ALTER TABLE organisation_staff ADD COLUMN role TEXT;
ALTER TABLE organisation_staff ADD COLUMN credential_expiry TEXT;
ALTER TABLE organisation_staff ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS flow_task (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  owner      TEXT,
  priority   INTEGER NOT NULL DEFAULT 100,
  due_date   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  closed_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS flow_task_open_idx ON flow_task (status, due_date, priority);

CREATE TABLE IF NOT EXISTS security_sync_device (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  site_id          TEXT,
  trust_state      TEXT NOT NULL DEFAULT 'trusted',
  software_version TEXT,
  revoked_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS organisation_facility_resource (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,           -- room|service_point|equipment
  name       TEXT NOT NULL,
  capacity   INTEGER,
  site_id    TEXT,
  status     TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS organisation_facility_resource_kind_idx ON organisation_facility_resource (kind, status);

CREATE TABLE IF NOT EXISTS organisation_checklist_template (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL,
  items  TEXT NOT NULL,               -- JSON array of {key,label,required}
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS organisation_checklist_run (
  id            TEXT PRIMARY KEY,
  template_code TEXT NOT NULL REFERENCES organisation_checklist_template(code),
  performed_by  TEXT,
  results       TEXT NOT NULL,        -- JSON object
  complete      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS organisation_incident (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,     -- incident|complaint|near_miss|failure
  severity          TEXT NOT NULL DEFAULT 'low',
  description       TEXT NOT NULL,
  reported_by       TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  corrective_action TEXT,
  closed_by         TEXT,
  closed_at         TEXT,
  reported_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS organisation_incident_status_idx ON organisation_incident (status);

CREATE TABLE IF NOT EXISTS organisation_maintenance_record (
  id           TEXT PRIMARY KEY,
  resource_id  TEXT NOT NULL REFERENCES organisation_facility_resource(id),
  kind         TEXT NOT NULL,         -- maintenance|calibration|downtime
  due_date     TEXT NOT NULL,
  performed_at TEXT,
  performed_by TEXT,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS organisation_maintenance_due_idx ON organisation_maintenance_record (performed_at, due_date);
