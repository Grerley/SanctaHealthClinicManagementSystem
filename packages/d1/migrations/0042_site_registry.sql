-- Multi-site registry columns on D1 (OPS-008). Extends organisation_site
-- (migration 0041) with a code and a central-node flag so scoped listing can
-- distinguish central roles (whole network) from local users (own site).
-- Booleans INTEGER 0/1.

ALTER TABLE organisation_site ADD COLUMN code TEXT;
ALTER TABLE organisation_site ADD COLUMN is_central INTEGER NOT NULL DEFAULT 0;

UPDATE organisation_site SET code='MAIN', is_central=1 WHERE id='site-main' AND code IS NULL;
