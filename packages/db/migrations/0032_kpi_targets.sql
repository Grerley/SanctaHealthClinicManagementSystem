-- ---------------------------------------------------------------------------
-- 0032 KPI targets & snapshots (MGT-004, MGT-005)
--
-- Targets/thresholds are effective-dated configuration (MGT-004); snapshots let a
-- KPI be compared to prior periods for trend/target reporting (MGT-005).
-- ---------------------------------------------------------------------------

CREATE TABLE organisation.kpi_target (
  kpi_id        text NOT NULL,
  version       integer NOT NULL,
  effective_from date NOT NULL,
  effective_to  date,
  target_value  numeric,
  warn_at       numeric,
  crit_at       numeric,
  direction     text NOT NULL DEFAULT 'higher_better', -- higher_better | lower_better
  commentary    text,
  changed_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kpi_id, version)
);

CREATE TABLE organisation.kpi_snapshot (
  id          uuid PRIMARY KEY,
  kpi_id      text NOT NULL,
  period      text NOT NULL,        -- e.g. 2026-07
  value       numeric NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kpi_id, period)
);
