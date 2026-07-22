-- Prescribing with allergy checking + controlled override (MED-002/003/004/009,
-- UAT-05). A medication request is checked against active allergies by substance
-- code; a match blocks unless an authorised prescriber supplies an override
-- reason (recorded + audited). Administrations are append-only; a not-given event
-- must carry a reason (CHECK). Ported from the Postgres clinical schema.

CREATE TABLE IF NOT EXISTS clinical_allergy (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL REFERENCES identity_patient(id),
  substance_code TEXT NOT NULL,
  severity       TEXT NOT NULL DEFAULT 'high',
  noted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_allergy_patient_idx ON clinical_allergy (patient_id);

CREATE TABLE IF NOT EXISTS clinical_medication_request (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES identity_patient(id),
  encounter_id    TEXT,
  medicine_code   TEXT NOT NULL,
  substance_code  TEXT NOT NULL,
  dose            TEXT,
  route           TEXT,
  frequency       TEXT,
  duration_days   INTEGER,
  quantity        INTEGER,
  instructions    TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  prescribed_by   TEXT,
  override_reason TEXT,
  override_by     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_medication_request_patient_idx ON clinical_medication_request (patient_id);

CREATE TABLE IF NOT EXISTS clinical_rx_template (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS clinical_rx_template_item (
  id             TEXT PRIMARY KEY,
  template_code  TEXT NOT NULL REFERENCES clinical_rx_template(code),
  medicine_code  TEXT NOT NULL,
  substance_code TEXT NOT NULL,
  dose           TEXT,
  route          TEXT,
  frequency      TEXT,
  duration_days  INTEGER,
  quantity       INTEGER,
  instructions   TEXT
);
CREATE INDEX IF NOT EXISTS clinical_rx_template_item_tpl_idx ON clinical_rx_template_item (template_code);

CREATE TABLE IF NOT EXISTS clinical_medication_administration (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES clinical_medication_request(id),
  patient_id      TEXT NOT NULL REFERENCES identity_patient(id),
  administered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  dose            TEXT,
  route           TEXT,
  site            TEXT,
  performer       TEXT,
  status          TEXT NOT NULL DEFAULT 'given',
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (status <> 'not_given' OR reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS clinical_medication_administration_request_idx ON clinical_medication_administration (request_id, administered_at);
