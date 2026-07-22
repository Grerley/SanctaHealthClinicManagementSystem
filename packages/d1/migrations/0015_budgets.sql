-- Budgets on D1 (FIN-007). A budget sets an expected amount for an account in a
-- period (optionally per site); variance compares it to ACTUAL posted to that
-- account in the period, so variance always reconciles to the ledger. Ported from
-- the Postgres finance schema.

CREATE TABLE IF NOT EXISTS finance_budget (
  id           TEXT PRIMARY KEY,
  account_code TEXT NOT NULL REFERENCES finance_account(code),
  period_id    TEXT NOT NULL,
  site_id      TEXT,
  amount_minor INTEGER NOT NULL,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (account_code, period_id, site_id)
);
