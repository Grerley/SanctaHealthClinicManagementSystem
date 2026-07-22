-- Cashier shift operations on D1 (BIL-009, UAT-09). Open a shift; close it against
-- the immutable payment record with a physical denomination count, a variance, a
-- supervisor-approval gate above tolerance, and a cash-over/short journal. The
-- shift never edits payments. Ported from the Postgres billing schema.
-- billing_payment already carries shift_id (0002). Seeds the cash-over/short
-- account the variance journal posts to.

INSERT OR IGNORE INTO finance_account (code, name, type) VALUES
  ('6900-CASH-OVER-SHORT', 'Cash over/short', 'expense');

CREATE TABLE IF NOT EXISTS billing_cashier_shift (
  id                  TEXT PRIMARY KEY,
  cashier             TEXT NOT NULL,
  site_id             TEXT,
  status              TEXT NOT NULL DEFAULT 'open',
  opening_float_minor INTEGER NOT NULL CHECK (opening_float_minor >= 0),
  opened_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  counted_minor       INTEGER,
  expected_minor      INTEGER,
  variance_minor      INTEGER,
  approved_by         TEXT,
  closed_at           TEXT
);
