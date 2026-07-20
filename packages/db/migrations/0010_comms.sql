-- 0010_comms.sql — patient communication preferences and outbound messages
-- (COM-001/002/003). Kept in the flow schema. Consent/preference is checked before
-- a message is created; a unique dedup key makes an offline-created message send
-- exactly once.

BEGIN;

CREATE TABLE flow.communication_preference (
  id          uuid PRIMARY KEY,
  patient_id  uuid NOT NULL REFERENCES identity.patient(id),
  purpose     text NOT NULL,        -- clinical | billing | reminder | outreach
  channel     text NOT NULL,        -- sms | email | print
  allowed     boolean NOT NULL,
  UNIQUE (patient_id, purpose, channel)
);

CREATE TABLE flow.message (
  id          uuid PRIMARY KEY,
  patient_id  uuid NOT NULL REFERENCES identity.patient(id),
  purpose     text NOT NULL,
  channel     text NOT NULL,
  template    text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',  -- queued | sent | suppressed
  dedup_key   text NOT NULL UNIQUE,            -- send exactly once (COM-002)
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX message_status_idx ON flow.message (status, created_at);

COMMIT;
