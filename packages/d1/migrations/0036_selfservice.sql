-- Patient self-service on D1 (COM-006, §11). A scoped token authenticates a
-- patient (separate from staff RBAC) to see their balance/appointments and to
-- REQUEST a booking or signal an intent to pay. Self-service never acts directly:
-- a booking request and a payment intent are always STAFF-confirmed. Booleans are
-- INTEGER 0/1; token expiry is stored ISO text.

CREATE TABLE IF NOT EXISTS flow_self_service_token (
  token      TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES identity_patient(id),
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS flow_booking_request (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL REFERENCES identity_patient(id),
  provider       TEXT,
  service_code   TEXT,
  preferred_date TEXT,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  appointment_id TEXT,
  decided_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS flow_payment_intent (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES identity_patient(id),
  amount_minor INTEGER NOT NULL,
  method       TEXT NOT NULL DEFAULT 'mobile',
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
