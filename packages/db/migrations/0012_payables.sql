-- 0012_payables.sql — expenses and accounts payable (FIN-005/006, UAT-12). An
-- approved expense creates a payable and posts Dr expense / Cr supplier AP; paying
-- it posts Dr supplier AP / Cr cash. The AP subledger reconciles to the GL control.

BEGIN;

CREATE TABLE finance.expense (
  id           uuid PRIMARY KEY,
  category     text NOT NULL,
  supplier     text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status       text NOT NULL DEFAULT 'approved',
  approved_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance.payable (
  id           uuid PRIMARY KEY,
  expense_id   uuid REFERENCES finance.expense(id),
  supplier     text,
  amount_minor bigint NOT NULL,
  paid_minor   bigint NOT NULL DEFAULT 0,
  due_date     date,
  status       text NOT NULL DEFAULT 'open',   -- open | paid
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payable_status_idx ON finance.payable (status);

COMMIT;
