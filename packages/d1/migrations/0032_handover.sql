-- Clinical handover & internal messages on D1 (EHR-012, §7.7). A message is
-- addressed to a staff member, optionally linked to a patient and/or a task, and
-- acknowledged by the recipient; the inbox surfaces unacknowledged items first so
-- handovers are not missed. Acknowledgement is recorded with provenance.

CREATE TABLE IF NOT EXISTS clinical_handover (
  id              TEXT PRIMARY KEY,
  from_staff      TEXT,
  to_staff        TEXT NOT NULL,
  patient_id      TEXT,
  task_id         TEXT,
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_handover_inbox_idx ON clinical_handover (to_staff, status, created_at);
