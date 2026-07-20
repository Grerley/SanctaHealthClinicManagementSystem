-- ---------------------------------------------------------------------------
-- 0024 facility resources, checklists, incidents & maintenance
-- (OPS-002/004/005/006)
--
-- Rooms/service points/equipment with capacity and status; operational checklists
-- (opening/closing/safety/cleaning/cold-chain/cash) with completion tracking;
-- incident/complaint/near-miss capture with corrective actions; and equipment
-- maintenance/calibration/downtime scheduling.
-- ---------------------------------------------------------------------------

CREATE TABLE organisation.facility_resource (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL,               -- room | service_point | equipment
  name        text NOT NULL,
  capacity    integer,                      -- rooms/service points
  site_id     uuid,
  status      text NOT NULL DEFAULT 'available', -- available | in_use | maintenance | retired
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facility_resource_kind_idx ON organisation.facility_resource (kind, status);

CREATE TABLE organisation.checklist_template (
  code    text PRIMARY KEY,
  name    text NOT NULL,
  kind    text NOT NULL,                    -- opening | closing | safety | cleaning | cold_chain | cash
  items   jsonb NOT NULL,                   -- [{key, label, required}]
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE organisation.checklist_run (
  id             uuid PRIMARY KEY,
  template_code  text NOT NULL REFERENCES organisation.checklist_template(code),
  performed_by   uuid,
  performed_at   timestamptz NOT NULL DEFAULT now(),
  results        jsonb NOT NULL DEFAULT '{}',
  complete       boolean NOT NULL DEFAULT false,
  notes          text
);
CREATE INDEX checklist_run_template_idx ON organisation.checklist_run (template_code, performed_at);

CREATE TABLE organisation.incident (
  id                 uuid PRIMARY KEY,
  kind               text NOT NULL,          -- incident | complaint | near_miss | failure
  severity           text NOT NULL DEFAULT 'low', -- low | medium | high
  description        text NOT NULL,
  reported_by        uuid,
  reported_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'open', -- open | investigating | closed
  corrective_action  text,
  closed_by          uuid,
  closed_at          timestamptz
);
CREATE INDEX incident_status_idx ON organisation.incident (status, severity);

CREATE TABLE organisation.maintenance_record (
  id            uuid PRIMARY KEY,
  resource_id   uuid REFERENCES organisation.facility_resource(id),
  kind          text NOT NULL,               -- maintenance | calibration | downtime
  due_date      date,
  performed_at  timestamptz,
  performed_by  uuid,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_due_idx ON organisation.maintenance_record (kind, due_date) WHERE performed_at IS NULL;
