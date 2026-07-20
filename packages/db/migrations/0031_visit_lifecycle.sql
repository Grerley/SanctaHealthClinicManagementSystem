-- ---------------------------------------------------------------------------
-- 0031 visit escalation, event log & outcomes (VIS-004/006/007)
--
-- VIS-004: clinical priority / emergency escalation (audited, reason required).
-- VIS-006: an append-only visit-event log gives automatic waiting/start/end
-- timestamps that reconcile to the visit's history.
-- VIS-007: hold / left-before-seen / refuse / cancel outcomes with a reason.
-- ---------------------------------------------------------------------------

ALTER TABLE flow.visit ADD COLUMN priority   integer NOT NULL DEFAULT 100; -- lower = higher
ALTER TABLE flow.visit ADD COLUMN started_at timestamptz;                  -- in-care start
ALTER TABLE flow.visit ADD COLUMN outcome    text;                         -- left_before_seen | refused | cancelled

CREATE TABLE flow.visit_event (
  id           uuid PRIMARY KEY,
  visit_id     uuid NOT NULL REFERENCES flow.visit(id),
  event        text NOT NULL,   -- opened | started | on_hold | resumed | escalated | complete | left_before_seen | refused | cancelled
  detail       text,
  actor        uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_event_visit_idx ON flow.visit_event (visit_id, occurred_at);
