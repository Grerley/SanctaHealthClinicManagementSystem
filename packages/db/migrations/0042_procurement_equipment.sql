-- ---------------------------------------------------------------------------
-- 0042 Requisitions/POs & equipment register (INV-003, INV-010)
--
--  * requisition / requisition_line — internal stock requests. Approval is
--    segregated (approver != requester, BR-011) and, above a value threshold,
--    must be approved by an authorised role (SoD threshold, INV-003).
--  * purchase_order / purchase_order_line — a PO raised from an approved
--    requisition against a supplier.
--  * equipment / equipment_service — the fixed-asset register: tag, location,
--    custodian, service status and an append-only service history (INV-010).
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE inventory.requisition (
  id            uuid PRIMARY KEY,
  reference     text UNIQUE NOT NULL,
  requested_by  uuid,
  status        text NOT NULL DEFAULT 'submitted', -- submitted|approved|rejected|ordered
  est_value_minor bigint NOT NULL DEFAULT 0,
  approved_by   uuid,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory.requisition_line (
  id             uuid PRIMARY KEY,
  requisition_id uuid NOT NULL REFERENCES inventory.requisition(id),
  sku            text NOT NULL REFERENCES inventory.product(sku),
  quantity       integer NOT NULL CHECK (quantity > 0)
);
CREATE INDEX requisition_line_req_idx ON inventory.requisition_line (requisition_id);

CREATE TABLE inventory.purchase_order (
  id             uuid PRIMARY KEY,
  reference      text UNIQUE NOT NULL,
  requisition_id uuid REFERENCES inventory.requisition(id),
  supplier       text NOT NULL,
  status         text NOT NULL DEFAULT 'open', -- open|received|closed
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory.purchase_order_line (
  id              uuid PRIMARY KEY,
  po_id           uuid NOT NULL REFERENCES inventory.purchase_order(id),
  sku             text NOT NULL REFERENCES inventory.product(sku),
  quantity        integer NOT NULL CHECK (quantity > 0),
  unit_cost_minor bigint NOT NULL DEFAULT 0
);
CREATE INDEX purchase_order_line_po_idx ON inventory.purchase_order_line (po_id);

CREATE TABLE inventory.equipment (
  id                uuid PRIMARY KEY,
  asset_tag         text UNIQUE NOT NULL,
  name              text NOT NULL,
  location          text,
  custodian         uuid,
  status            text NOT NULL DEFAULT 'in_service', -- in_service|out_of_service|retired
  next_service_date date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory.equipment_service (
  id            uuid PRIMARY KEY,
  equipment_id  uuid NOT NULL REFERENCES inventory.equipment(id),
  serviced_on   date NOT NULL,
  note          text,
  performed_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_service_eq_idx ON inventory.equipment_service (equipment_id, serviced_on DESC);

COMMIT;
