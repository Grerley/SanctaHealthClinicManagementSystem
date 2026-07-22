-- D1/SQLite — inventory core (INV-005/006). Table names are flat (no schemas in
-- SQLite): the Postgres `inventory.lot` becomes `inventory_lot`.
--
-- Concurrency without row locks: movements stay append-only for history, and a
-- maintained balance row with CHECK(on_hand >= 0) is the atomic gate. A dispense
-- is one batch() — insert movement + decrement balance — so a concurrent
-- over-draw trips the CHECK and the whole batch rolls back (no oversell), instead
-- of relying on SELECT … FOR UPDATE.

CREATE TABLE IF NOT EXISTS inventory_lot (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL,
  expiry_date     TEXT NOT NULL,                     -- ISO date
  status          TEXT NOT NULL DEFAULT 'available', -- available|quarantined|expired|recalled
  unit_cost_minor INTEGER NOT NULL,
  supplier        TEXT
);
CREATE INDEX IF NOT EXISTS inventory_lot_sku_idx ON inventory_lot (sku);

CREATE TABLE IF NOT EXISTS inventory_stock_movement (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL,
  lot_id        TEXT NOT NULL REFERENCES inventory_lot(id),
  location      TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity      INTEGER NOT NULL,                    -- signed base units
  occurred_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  source_ref    TEXT
);
CREATE INDEX IF NOT EXISTS inventory_stock_movement_lot_idx ON inventory_stock_movement (lot_id);

CREATE TABLE IF NOT EXISTS inventory_stock_balance (
  lot_id   TEXT NOT NULL REFERENCES inventory_lot(id),
  location TEXT NOT NULL,
  sku      TEXT NOT NULL,
  on_hand  INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),  -- the concurrency gate
  PRIMARY KEY (lot_id, location)
);
CREATE INDEX IF NOT EXISTS inventory_stock_balance_sku_idx ON inventory_stock_balance (sku);
