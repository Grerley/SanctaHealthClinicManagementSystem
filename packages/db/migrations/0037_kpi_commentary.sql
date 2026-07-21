-- ---------------------------------------------------------------------------
-- 0037 KPI commentary & action log (MGT-010)
--
-- Managers annotate a KPI for a period with a narrative and, where a band is
-- breached, a corrective action with an owner and due date. Commentary is
-- append-only history (one row per authored note) so the record of *why* a
-- number moved — and what was decided — cannot be silently overwritten.
-- ---------------------------------------------------------------------------

CREATE TABLE organisation.kpi_commentary (
  id           uuid PRIMARY KEY,
  kpi_id       text NOT NULL,
  period       text NOT NULL,        -- e.g. 2026-07
  commentary   text NOT NULL,
  action       text,                 -- corrective action, if any
  action_owner uuid,                 -- who owns the action
  due_date     date,
  status       text NOT NULL DEFAULT 'open', -- open | in_progress | done
  authored_by  uuid,
  authored_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kpi_commentary_kpi_period_idx ON organisation.kpi_commentary (kpi_id, period, authored_at DESC);
