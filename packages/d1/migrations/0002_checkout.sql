-- D1/SQLite — the checkout vertical: patients, billing, finance ledger, sync/audit.
-- Flat table names (no schemas). Money is INTEGER minor units (exact). Double-entry
-- integrity is guaranteed by the domain posting rules; the ledger tables just store
-- the balanced batches. The idempotency key's PRIMARY KEY makes a replayed checkout
-- fail the atomic batch and roll back (NFR-010).

CREATE TABLE IF NOT EXISTS identity_patient (
  id            TEXT PRIMARY KEY,
  mrn           TEXT UNIQUE,
  given_name    TEXT,
  family_name   TEXT,
  date_of_birth TEXT,
  sex           TEXT,
  site_id       TEXT,
  sensitivity   TEXT NOT NULL DEFAULT 'normal',
  deceased      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS billing_invoice (
  id             TEXT PRIMARY KEY,
  invoice_number TEXT UNIQUE,
  patient_id     TEXT NOT NULL REFERENCES identity_patient(id),
  status         TEXT NOT NULL DEFAULT 'draft',
  currency       TEXT NOT NULL DEFAULT 'USD',
  finalised_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS billing_invoice_line (
  id             TEXT PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES billing_invoice(id),
  service_code   TEXT NOT NULL,
  rule_version   INTEGER NOT NULL,
  standard_minor INTEGER NOT NULL,
  applied_minor  INTEGER NOT NULL,
  adjustment_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor      INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  approver       TEXT
);
CREATE INDEX IF NOT EXISTS billing_invoice_line_inv_idx ON billing_invoice_line (invoice_id);

CREATE TABLE IF NOT EXISTS billing_payment (
  id             TEXT PRIMARY KEY,
  receipt_number TEXT UNIQUE,
  patient_id     TEXT NOT NULL REFERENCES identity_patient(id),
  method         TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  status         TEXT NOT NULL DEFAULT 'confirmed',
  shift_id       TEXT,
  received_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS billing_payment_allocation (
  id           TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL REFERENCES billing_payment(id),
  invoice_id   TEXT NOT NULL REFERENCES billing_invoice(id),
  amount_minor INTEGER NOT NULL,
  allocated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS finance_financial_period (
  id        TEXT PRIMARY KEY,                 -- e.g. 2026-07
  status    TEXT NOT NULL DEFAULT 'open',     -- open|soft_close|hard_close
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS finance_account (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL                          -- asset|liability|equity|revenue|expense
);

CREATE TABLE IF NOT EXISTS finance_journal_batch (
  id           TEXT PRIMARY KEY,
  origin       TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  posting_date TEXT NOT NULL,
  period_id    TEXT REFERENCES finance_financial_period(id),
  reverses     TEXT REFERENCES finance_journal_batch(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS finance_journal_line (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES finance_journal_batch(id),
  account_code TEXT NOT NULL REFERENCES finance_account(code),
  debit_minor  INTEGER NOT NULL DEFAULT 0,
  credit_minor INTEGER NOT NULL DEFAULT 0,
  cost_centre  TEXT,
  memo         TEXT,
  CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CHECK (NOT (debit_minor > 0 AND credit_minor > 0))
);
CREATE INDEX IF NOT EXISTS finance_journal_line_acct_idx ON finance_journal_line (account_code);

CREATE TABLE IF NOT EXISTS security_sync_applied_change (
  idempotency_key TEXT PRIMARY KEY,
  applied_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS security_sync_outbox_item (
  idempotency_key TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  entity_version  INTEGER NOT NULL DEFAULT 1,
  origin_site     TEXT,
  device_id       TEXT,
  user_id         TEXT,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 50,
  sync_state      TEXT NOT NULL DEFAULT 'queued',
  captured_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  payload         TEXT
);

CREATE TABLE IF NOT EXISTS audit_event (
  id            TEXT PRIMARY KEY,
  actor_user    TEXT,
  site_id       TEXT,
  device_id     TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  patient_ref   TEXT,
  outcome       TEXT NOT NULL,
  reason        TEXT,
  captured_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  event_hash    TEXT
);

-- Seed the chart of accounts (matches @sancta/domain ACCOUNTS).
INSERT OR IGNORE INTO finance_account (code, name, type) VALUES
  ('1000-CASH','Cash','asset'),
  ('1010-BANK-CLEARING','Bank clearing','asset'),
  ('1020-MM-CLEARING','Mobile-money clearing','asset'),
  ('1200-PATIENT-AR','Patient accounts receivable','asset'),
  ('1300-INVENTORY','Inventory','asset'),
  ('2200-PATIENT-DEPOSIT','Patient deposits','liability'),
  ('4000-SERVICE-REVENUE','Service revenue','revenue'),
  ('4010-MEDICINE-REVENUE','Medicine revenue','revenue'),
  ('5000-COGS','Cost of goods sold','expense');
