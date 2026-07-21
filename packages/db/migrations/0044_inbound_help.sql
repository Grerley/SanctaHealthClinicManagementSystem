-- ---------------------------------------------------------------------------
-- 0044 Inbound responses → tasks & local help (COM-004, ADM-008)
--
--  * inbound_message — a received patient response (e.g. an SMS reply), linked to
--    the source outbound message where known (COM-004).
--  * comms_task — a follow-up task raised from an inbound response, linked to its
--    source so staff can act on it and close the loop (COM-004).
--  * help_topic — local, offline help/onboarding content served from the edge so
--    guidance is available without connectivity (ADM-008).
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE flow.inbound_message (
  id            uuid PRIMARY KEY,
  patient_id    uuid REFERENCES identity.patient(id),
  channel       text NOT NULL DEFAULT 'sms',
  body          text NOT NULL,
  in_reply_to   uuid REFERENCES flow.message(id),   -- source outbound message, if known
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_message_patient_idx ON flow.inbound_message (patient_id);

CREATE TABLE flow.comms_task (
  id            uuid PRIMARY KEY,
  inbound_id    uuid NOT NULL REFERENCES flow.inbound_message(id),
  patient_id    uuid REFERENCES identity.patient(id),
  summary       text NOT NULL,
  status        text NOT NULL DEFAULT 'open',        -- open | done
  assigned_role text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  closed_by     uuid
);
CREATE INDEX comms_task_open_idx ON flow.comms_task (status, created_at) WHERE status = 'open';

CREATE TABLE organisation.help_topic (
  slug        text PRIMARY KEY,
  title       text NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  body        text NOT NULL,
  step_order  integer,                               -- set for onboarding steps
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed a little offline help/onboarding content (synthetic).
INSERT INTO organisation.help_topic (slug, title, category, body, step_order) VALUES
  ('getting-started', 'Getting started', 'onboarding', 'Sign in with your assigned role. Your work queue shows what needs attention.', 1),
  ('register-patient', 'Registering a patient', 'onboarding', 'Search first to avoid duplicates, then capture the required demographics.', 2),
  ('record-a-payment', 'Recording a payment', 'onboarding', 'Open the visit, select outstanding charges, take payment and print the receipt.', 3),
  ('offline-working', 'Working offline', 'general', 'The app works without connectivity. Changes queue locally and sync when a connection returns.', NULL);

COMMIT;
