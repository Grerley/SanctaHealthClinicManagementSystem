-- 0006_refund.sql — refunds as linked compensating transactions (BIL-010, BR).
-- A refund never edits the original payment/receipt; it is a new record linked to
-- the payment, with an approver, and posts a reversing journal.

BEGIN;

CREATE TABLE billing.refund (
  id           uuid PRIMARY KEY,
  payment_id   uuid NOT NULL REFERENCES billing.payment(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  method       text NOT NULL,
  reason       text NOT NULL,
  approved_by  uuid NOT NULL,                 -- refunds require authorisation
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refund_payment_idx ON billing.refund (payment_id);

COMMIT;
