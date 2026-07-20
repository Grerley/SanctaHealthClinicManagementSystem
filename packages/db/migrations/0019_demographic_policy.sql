-- ---------------------------------------------------------------------------
-- 0019 configurable demographic capture policy (PAT-004)
--
-- Each demographic field can be mandatory, and a mandatory field may be satisfied
-- by a value or (where permitted) an explicit unknown/declined marker so it is
-- never silently skipped. The markers a registration used are preserved on the
-- patient for audit and data-quality reporting.
-- ---------------------------------------------------------------------------

CREATE TABLE identity.demographic_field (
  field          text PRIMARY KEY,
  required       boolean NOT NULL DEFAULT false,
  allow_unknown  boolean NOT NULL DEFAULT false,
  allow_declined boolean NOT NULL DEFAULT false,
  display_order  integer NOT NULL DEFAULT 100
);

ALTER TABLE identity.patient ADD COLUMN demographic_markers jsonb NOT NULL DEFAULT '{}';

-- Default policy: names mandatory; DOB mandatory but may be unknown (estimated
-- ages are common); sex optional; phone optional but may be declined.
INSERT INTO identity.demographic_field (field, required, allow_unknown, allow_declined, display_order) VALUES
  ('given_name',    true,  false, false, 10),
  ('family_name',   true,  false, false, 20),
  ('date_of_birth', true,  true,  false, 30),
  ('sex',           false, false, false, 40),
  ('phone',         false, false, true,  50);
