-- Refunds on D1 (BIL-010). A refund is a linked, authorised compensating record —
-- the original payment/receipt is never edited. amount>0 enforced by CHECK; an
-- approver is mandatory. The payment/allocation tables already exist (0002).
-- Ported from the Postgres billing schema.

CREATE TABLE IF NOT EXISTS billing_refund (
  id           TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL REFERENCES billing_payment(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  approved_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS billing_refund_payment_idx ON billing_refund (payment_id);
