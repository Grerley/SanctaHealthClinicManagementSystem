-- ---------------------------------------------------------------------------
-- 0030 multi-site registry (OPS-008)
--
-- Each site runs local operations; central roles have network-wide oversight.
-- The registry is reference data; site-scoped access is enforced by the domain
-- authorisation matrix (packages/domain/src/site.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE organisation.site (
  id          uuid PRIMARY KEY,
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  is_central  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The default site referenced across the edge (matches DEFAULT_SITE in code).
INSERT INTO organisation.site (id, code, name, is_central) VALUES
  ('00000000-0000-7000-8000-0000000000f1', 'MAIN', 'Main clinic', true);
