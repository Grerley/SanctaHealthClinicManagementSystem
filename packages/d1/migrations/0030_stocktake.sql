-- Stocktake variance posting on D1 (INV-008). A shrinkage/gain adjustment posts a
-- balanced journal against inventory and the supplies/shrinkage expense account.
-- Seed 5100-SUPPLIES-EXPENSE (matches @sancta/domain ACCOUNTS.suppliesExpense);
-- 1300-INVENTORY is already seeded (migration 0002). No new tables — stocktake
-- reads/writes the existing inventory_lot / inventory_stock_movement /
-- inventory_stock_balance from migration 0001.

INSERT OR IGNORE INTO finance_account (code, name, type) VALUES
  ('5100-SUPPLIES-EXPENSE','Supplies & shrinkage expense','expense');
