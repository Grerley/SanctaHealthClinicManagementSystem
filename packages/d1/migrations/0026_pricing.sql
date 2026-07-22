-- Effective-dated fee schedule / price book on D1 (BIL-001, BIL-003, BR-005).
-- Each (service_code, version) is an effective-dated rate band; the prior version
-- is closed by setting effective_to when a new one is defined. Charging a service
-- retains the applied rule version on the invoice line (billing_invoice_line,
-- migration 0002) so a later price change never rewrites a historical invoice.

CREATE TABLE IF NOT EXISTS billing_fee_version (
  service_code   TEXT NOT NULL,
  version        INTEGER NOT NULL,
  effective_from TEXT NOT NULL,           -- ISO date, inclusive
  effective_to   TEXT,                    -- ISO date, exclusive; open-ended if null
  standard_minor INTEGER NOT NULL,
  min_minor      INTEGER NOT NULL,
  max_minor      INTEGER NOT NULL,
  tax_rate_bps   INTEGER,                 -- basis points, e.g. 1500 = 15%
  currency       TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY (service_code, version)
);

-- Tax split lands in a liability account; seed it alongside AR/revenue (0002).
INSERT OR IGNORE INTO finance_account (code, name, type) VALUES
  ('2300-TAX-PAYABLE','Tax payable','liability');

-- A representative synthetic fee so the module is exercisable end-to-end.
INSERT OR IGNORE INTO billing_fee_version (service_code, version, effective_from, standard_minor, min_minor, max_minor, tax_rate_bps, currency)
  VALUES ('CONSULT-GP', 1, '2026-01-01', 5000, 4000, 8000, 1500, 'USD');
