-- Versioned config releases, feature flags, help topics on D1 (ADM-003/006/008).
-- Config changes move draft -> test -> approved -> published with maker-checker
-- approval; publishing supersedes the prior published release and rollback
-- re-publishes it. Feature flags gate staged rollout by site/role. Help topics are
-- served locally. Booleans INTEGER 0/1; JSON (payload, sites, roles) as TEXT.

CREATE TABLE IF NOT EXISTS organisation_config_release (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft|test|approved|published|rolled_back
  created_by   TEXT,
  approved_by  TEXT,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS organisation_config_release_name_idx ON organisation_config_release (name, version);

CREATE TABLE IF NOT EXISTS organisation_feature_flag (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  sites      TEXT NOT NULL DEFAULT '[]',   -- JSON array; empty = all sites
  roles      TEXT NOT NULL DEFAULT '[]',   -- JSON array; empty = all roles
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS organisation_help_topic (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL,
  body       TEXT NOT NULL,
  step_order INTEGER
);

INSERT OR IGNORE INTO organisation_help_topic (slug, title, category, body, step_order) VALUES
  ('getting-started','Getting started','onboarding','Sign in, select your station, and open the queue board.',1),
  ('register-patient','Registering a patient','onboarding','Use Patients > New to register; duplicates are checked automatically.',2),
  ('offline','Working offline','help','The app keeps working offline; changes sync when the connection returns.',NULL);
