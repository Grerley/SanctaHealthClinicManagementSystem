-- ---------------------------------------------------------------------------
-- 0022 online-integration queue (SYN-010, CLD-003)
--
-- Outbound integrations (SMS, external reporting, cloud webhooks) are queued
-- locally as part of the business transaction. Delivery is out-of-band with
-- bounded retry; after max attempts an item moves to the dead-letter state (DLQ)
-- for an audited, idempotent replay. A failing integration never blocks or rolls
-- back the local clinical/financial transaction.
-- ---------------------------------------------------------------------------

CREATE TABLE security_sync.integration_queue (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL,                 -- sms | report | webhook | ...
  idempotency_key  text NOT NULL UNIQUE,          -- dedup across retries/replays (NFR-010)
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued', -- queued | delivered | dead
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX integration_queue_status_idx ON security_sync.integration_queue (status, created_at);
