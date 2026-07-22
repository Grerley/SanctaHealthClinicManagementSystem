-- Inventory products + receiving on credit + stock alerts on D1 (INV-004/009).
-- The product registry carries reorder settings; goods receipt posts Dr Inventory
-- / Cr Supplier-AP and maintains the balance (so dispense sees received stock);
-- alerts derive low/stockout/near-expiry/expired from the movement ledger. Ported
-- from the Postgres inventory schema. Seeds the demo SKU so alerts have a product.

CREATE TABLE IF NOT EXISTS inventory_product (
  sku         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT,
  base_unit   TEXT NOT NULL DEFAULT 'unit',
  controlled  INTEGER NOT NULL DEFAULT 0,
  reorder_min INTEGER,
  reorder_max INTEGER
);

INSERT OR IGNORE INTO inventory_product (sku, name, base_unit, reorder_min, reorder_max) VALUES
  ('AMOX-500', 'Amoxicillin 500mg', 'capsule', 50, 500);
