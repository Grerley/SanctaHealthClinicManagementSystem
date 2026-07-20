-- ---------------------------------------------------------------------------
-- 0035 versioned config releases + feature flags (ADM-003, ADM-006)
--
-- ADM-003: configuration changes ship as versioned releases with a controlled
-- lifecycle (draft → test → approved → published) and rollback; approval is a
-- maker-checker step. ADM-006: feature flags gate staged rollout by site/role.
-- ---------------------------------------------------------------------------

CREATE TABLE organisation.config_release (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  version       integer NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'draft', -- draft | test | approved | published | rolled_back
  created_by    uuid,
  approved_by   uuid,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX config_release_name_idx ON organisation.config_release (name, version);

CREATE TABLE organisation.feature_flag (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT false,
  sites      text[] NOT NULL DEFAULT '{}',  -- empty = all sites
  roles      text[] NOT NULL DEFAULT '{}',  -- empty = all roles
  updated_at timestamptz NOT NULL DEFAULT now()
);
