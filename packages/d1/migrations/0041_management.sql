-- Management command-centre extensions on D1 (MGT-002/007/010). Site registry for
-- scope resolution and an append-only KPI commentary/corrective-action log. The
-- dashboard itself derives live from the ledgers (no stored totals). Booleans
-- INTEGER 0/1.

CREATE TABLE IF NOT EXISTS organisation_site (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO organisation_site (id, name, active) VALUES
  ('site-main','Main clinic',1);

CREATE TABLE IF NOT EXISTS organisation_kpi_commentary (
  id           TEXT PRIMARY KEY,
  kpi_id       TEXT NOT NULL,
  period       TEXT NOT NULL,
  commentary   TEXT NOT NULL,
  action       TEXT,
  action_owner TEXT,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  authored_by  TEXT,
  authored_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS organisation_kpi_commentary_idx ON organisation_kpi_commentary (kpi_id, period, authored_at);
