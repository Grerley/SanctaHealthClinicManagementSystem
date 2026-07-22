-- Third-party payer coverage, pre-authorisation & claims on D1 (BIL-011, §10.3).
-- Eligibility is derived from active coverage as-of a date; a claim is raised
-- against an invoice's outstanding balance; the payer's remittance settles through
-- the normal payment path (a payer bank payment allocated to the invoice) so the
-- ledger and debtor balance stay correct and a claim never creates a shadow
-- balance. Booleans are INTEGER 0/1.

CREATE TABLE IF NOT EXISTS billing_payer (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS billing_coverage (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL REFERENCES identity_patient(id),
  payer_id       TEXT NOT NULL REFERENCES billing_payer(id),
  member_number  TEXT NOT NULL,
  plan           TEXT,
  priority       INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  active         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS billing_coverage_patient_idx ON billing_coverage (patient_id, priority);

CREATE TABLE IF NOT EXISTS billing_preauth (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL,
  patient_id    TEXT NOT NULL REFERENCES identity_patient(id),
  payer_id      TEXT NOT NULL REFERENCES billing_payer(id),
  service_code  TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'requested',
  authorisation TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS billing_claim (
  id              TEXT PRIMARY KEY,
  claim_number    TEXT NOT NULL UNIQUE,
  invoice_id      TEXT NOT NULL REFERENCES billing_invoice(id),
  coverage_id     TEXT NOT NULL REFERENCES billing_coverage(id),
  payer_id        TEXT NOT NULL REFERENCES billing_payer(id),
  submitted_minor INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted',
  decided_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS billing_claim_remittance (
  id               TEXT PRIMARY KEY,
  claim_id         TEXT NOT NULL REFERENCES billing_claim(id),
  paid_minor       INTEGER NOT NULL DEFAULT 0,
  adjustment_minor INTEGER NOT NULL DEFAULT 0,
  payment_id       TEXT,
  reason           TEXT,
  recorded_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
