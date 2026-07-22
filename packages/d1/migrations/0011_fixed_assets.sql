-- Fixed assets on D1 (FIN-008). Straight-line depreciation is computed in the
-- domain from these fields; disposal records proceeds + status. Ported from the
-- Postgres finance schema. Money is INTEGER minor; dates are 'YYYY-MM-DD' text.

CREATE TABLE IF NOT EXISTS finance_fixed_asset (
  id                      TEXT PRIMARY KEY,
  reference               TEXT UNIQUE NOT NULL,
  name                    TEXT NOT NULL,
  category                TEXT,
  cost_minor              INTEGER NOT NULL CHECK (cost_minor >= 0),
  salvage_minor           INTEGER NOT NULL DEFAULT 0 CHECK (salvage_minor >= 0),
  useful_life_months      INTEGER NOT NULL CHECK (useful_life_months > 0),
  acquired_on             TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active',
  disposed_on             TEXT,
  disposal_proceeds_minor INTEGER,
  created_by              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (salvage_minor <= cost_minor)
);
