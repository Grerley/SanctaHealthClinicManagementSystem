-- Month-end close on D1 (FIN-004). Closing reclassifies temporary accounts
-- (revenue/expense) into retained earnings. Seeds the retained-earnings equity
-- account the closing batch posts to (0002 did not include it) so the
-- journal_line FK holds. No new table — balance sheet + close derive from the
-- immutable ledger.

INSERT OR IGNORE INTO finance_account (code, name, type) VALUES
  ('3000-RETAINED-EARNINGS', 'Retained earnings', 'equity');
