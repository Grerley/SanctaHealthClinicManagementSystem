-- 0009_queue.sql — queue entries for visit flow (VIS-003/005/008). A visit has
-- one queue entry showing its token, current station, priority and status. The
-- token comes from a controlled sequence.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS flow.queue_token_seq START 1;

CREATE TABLE flow.queue_entry (
  id          uuid PRIMARY KEY,
  visit_id    uuid NOT NULL UNIQUE REFERENCES flow.visit(id),
  token       integer NOT NULL,
  station     text NOT NULL DEFAULT 'reception',
  priority    integer NOT NULL DEFAULT 100,        -- lower = higher priority
  status      text NOT NULL DEFAULT 'waiting',     -- waiting | in_service | done
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_station_idx ON flow.queue_entry (station, status, priority, token);

COMMIT;
