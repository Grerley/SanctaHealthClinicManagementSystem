-- Chart-of-accounts, cost-centre and dimension administration on D1 (FIN-001).
-- Reference data governed as configuration: accounts are effective-dated
-- (revising adds a new version and closes the prior — codes/posted history are
-- never rewritten); cost centres and dimensions are registries. Ported from the
-- Postgres finance schema. Booleans are INTEGER 0/1, dates 'YYYY-MM-DD' text.

-- finance_account (0002) predates the `active` mirror column; add it forward-only.
ALTER TABLE finance_account ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS finance_cost_centre (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS finance_dimension (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS finance_dimension_value (
  dimension_code TEXT NOT NULL REFERENCES finance_dimension(code),
  value_code     TEXT NOT NULL,
  label          TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (dimension_code, value_code)
);

CREATE TABLE IF NOT EXISTS finance_account_version (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL REFERENCES finance_account(code),
  version        INTEGER NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  parent_code    TEXT,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  changed_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (code, version)
);
