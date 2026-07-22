-- KPI targets + snapshots on D1 (MGT-004, MGT-005). Targets are effective-dated
-- configuration (audited); a snapshot records a KPI's value per period so the
-- current value can be compared to the prior period and banded against its target.

CREATE TABLE IF NOT EXISTS organisation_kpi_target (
  kpi_id         TEXT NOT NULL,
  version        INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  target_value   REAL,
  warn_at        REAL,
  crit_at        REAL,
  direction      TEXT NOT NULL DEFAULT 'higher_better',
  commentary     TEXT,
  changed_by     TEXT,
  PRIMARY KEY (kpi_id, version)
);

CREATE TABLE IF NOT EXISTS organisation_kpi_snapshot (
  id          TEXT PRIMARY KEY,
  kpi_id      TEXT NOT NULL,
  period      TEXT NOT NULL,
  value       REAL NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (kpi_id, period)
);
