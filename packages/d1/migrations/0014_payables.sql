-- Expenses & accounts payable on D1 (FIN-005/006, UAT-12). An approved expense
-- creates a payable and posts Dr expense / Cr supplier-AP; paying posts Dr AP /
-- Cr cash. The AP subledger reconciles to the GL supplier-AP control. Ported from
-- the Postgres finance schema. Seeds the two chart accounts the postings need
-- (0002 did not include them) so the journal_line FK holds.

INSERT OR IGNORE INTO finance_account (code, name, type) VALUES
  ('2100-SUPPLIER-AP', 'Supplier accounts payable', 'liability'),
  ('6000-OPERATING-EXPENSE', 'Operating expense', 'expense');

CREATE TABLE IF NOT EXISTS finance_expense (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  supplier     TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status       TEXT NOT NULL DEFAULT 'approved',
  approved_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS finance_payable (
  id           TEXT PRIMARY KEY,
  expense_id   TEXT REFERENCES finance_expense(id),
  supplier     TEXT,
  amount_minor INTEGER NOT NULL,
  paid_minor   INTEGER NOT NULL DEFAULT 0,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS finance_payable_status_idx ON finance_payable (status);
