-- ---------------------------------------------------------------------------
-- 0017 versioned chart of accounts, cost centres & dimensions (FIN-001)
--
-- Account CODES stay permanent (journal lines reference them forever); their
-- definition is effective-dated in finance.account_version so a rename or
-- reclassification never rewrites posted history. Cost centres and accounting
-- dimensions become governed reference data; a posted journal line's cost centre
-- must be a known, active one (validated at the posting choke point).
-- ---------------------------------------------------------------------------

CREATE TABLE finance.cost_centre (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance.dimension (
  code       text PRIMARY KEY,           -- e.g. PROGRAMME, FUNDER
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE finance.dimension_value (
  dimension_code text NOT NULL REFERENCES finance.dimension(code),
  value_code     text NOT NULL,
  label          text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (dimension_code, value_code)
);

CREATE TABLE finance.account_version (
  id             uuid PRIMARY KEY,
  code           text NOT NULL REFERENCES finance.account(code),
  version        integer NOT NULL,
  name           text NOT NULL,
  type           text NOT NULL,             -- asset|liability|equity|revenue|expense
  active         boolean NOT NULL DEFAULT true,
  parent_code    text,
  effective_from date NOT NULL,
  effective_to   date,                      -- exclusive; set when superseded
  changed_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
CREATE INDEX account_version_code_idx ON finance.account_version (code, effective_from);

-- Backfill version 1 for every existing account so the chart is fully versioned.
INSERT INTO finance.account_version (id, code, version, name, type, active, effective_from)
SELECT gen_random_uuid(), code, 1, name, type, active, DATE '2026-01-01'
FROM finance.account;

-- A default cost centre so existing flows post cleanly.
INSERT INTO finance.cost_centre (code, name) VALUES ('GEN', 'General') ON CONFLICT DO NOTHING;
