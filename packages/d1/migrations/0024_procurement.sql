-- Requisitions, purchase orders & the equipment register on D1 (INV-003/010).
-- Requisition approval is segregated (approver != requester) and above a value
-- threshold needs an authorised role; a PO is raised from an approved requisition;
-- the equipment register has an append-only service history. Ported from the
-- Postgres inventory schema.

CREATE TABLE IF NOT EXISTS inventory_requisition (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL,
  requested_by    TEXT,
  est_value_minor INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'submitted',
  approved_by     TEXT,
  decided_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS inventory_requisition_line (
  id             TEXT PRIMARY KEY,
  requisition_id TEXT NOT NULL REFERENCES inventory_requisition(id),
  sku            TEXT NOT NULL,
  quantity       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_purchase_order (
  id             TEXT PRIMARY KEY,
  reference      TEXT NOT NULL,
  requisition_id TEXT REFERENCES inventory_requisition(id),
  supplier       TEXT NOT NULL,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS inventory_purchase_order_line (
  id              TEXT PRIMARY KEY,
  po_id           TEXT NOT NULL REFERENCES inventory_purchase_order(id),
  sku             TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  unit_cost_minor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_equipment (
  id                TEXT PRIMARY KEY,
  asset_tag         TEXT NOT NULL,
  name              TEXT NOT NULL,
  location          TEXT,
  custodian         TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  next_service_date TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS inventory_equipment_service (
  id           TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES inventory_equipment(id),
  serviced_on  TEXT NOT NULL,
  note         TEXT,
  performed_by TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
