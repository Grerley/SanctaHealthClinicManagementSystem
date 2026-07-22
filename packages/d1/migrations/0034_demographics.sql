-- Demographic capture policy on D1 (PAT-004). A configurable field policy is
-- consumed by patient registration to validate mandatory / unknown / declined
-- fields. Booleans are INTEGER 0/1. Seeds a sensible synthetic default policy.

CREATE TABLE IF NOT EXISTS identity_demographic_field (
  field          TEXT PRIMARY KEY,
  required       INTEGER NOT NULL DEFAULT 0,
  allow_unknown  INTEGER NOT NULL DEFAULT 0,
  allow_declined INTEGER NOT NULL DEFAULT 0,
  display_order  INTEGER NOT NULL DEFAULT 100
);

INSERT OR IGNORE INTO identity_demographic_field (field, required, allow_unknown, allow_declined, display_order) VALUES
  ('given_name',    1, 0, 0, 10),
  ('family_name',   1, 0, 0, 20),
  ('date_of_birth', 1, 1, 0, 30),
  ('sex',           1, 1, 1, 40),
  ('phone',         0, 0, 1, 50),
  ('address',       0, 1, 1, 60);
