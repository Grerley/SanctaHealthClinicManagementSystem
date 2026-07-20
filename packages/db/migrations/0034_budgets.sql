-- ---------------------------------------------------------------------------
-- 0034 budgets & variance (FIN-007)
--
-- A budget line sets an expected amount for an account in a period (optionally by
-- site). Variance compares budget to the actual posted to the account's journal
-- lines in that period. Actuals come from the immutable ledger, never a stored total.
-- ---------------------------------------------------------------------------

CREATE TABLE finance.budget (
  id            uuid PRIMARY KEY,
  account_code  text NOT NULL REFERENCES finance.account(code),
  period_id     text NOT NULL,
  site_id       uuid,
  amount_minor  bigint NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_code, period_id, site_id)
);
