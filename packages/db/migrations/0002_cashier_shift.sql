-- 0002_cashier_shift.sql — cashier shifts and the shift link on payments
-- (BIL-009, pack §8.3, UAT-09). Forward migration; the rollback drops the column
-- and table. Applied identically at the edge and in the cloud.

BEGIN;

CREATE TABLE billing.cashier_shift (
  id                  uuid PRIMARY KEY,
  cashier             uuid NOT NULL,
  site_id             uuid,
  status              text NOT NULL DEFAULT 'open',   -- open | closed
  opening_float_minor bigint NOT NULL,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  counted_minor       bigint,
  expected_minor      bigint,
  variance_minor      bigint,
  approved_by         uuid,                           -- required when variance exceeds tolerance
  closed_at           timestamptz,
  CHECK (opening_float_minor >= 0)
);

-- A payment belongs to at most one shift; cash payments reconcile to the shift.
ALTER TABLE billing.payment ADD COLUMN shift_id uuid REFERENCES billing.cashier_shift(id);
CREATE INDEX payment_shift_idx ON billing.payment (shift_id);

COMMIT;
