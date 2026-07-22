-- Visit escalation, event log & outcomes on D1 (VIS-004/006/007, §5). Extends
-- flow_visit (migration 0003) with priority, lifecycle timestamps and a terminal
-- outcome, and adds an append-only visit event log so waiting/start/end durations
-- are DERIVED from history, never stored as editable totals. Booleans/enums are text.

ALTER TABLE flow_visit ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE flow_visit ADD COLUMN started_at TEXT;
ALTER TABLE flow_visit ADD COLUMN outcome TEXT;

CREATE TABLE IF NOT EXISTS flow_visit_event (
  id          TEXT PRIMARY KEY,
  visit_id    TEXT NOT NULL REFERENCES flow_visit(id),
  event       TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS flow_visit_event_visit_idx ON flow_visit_event (visit_id, occurred_at);
