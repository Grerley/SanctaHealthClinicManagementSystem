-- ---------------------------------------------------------------------------
-- 0039 Order sets, specimen accessions & outbound referrals (ORD-002/004/008)
--
--  * order_set / order_set_item — reusable order templates. Applying a set
--    creates individual DRAFT service requests that still require per-patient
--    review (ORD-002); the set never auto-activates orders.
--  * specimen — a patient-safe accession per collected sample (ORD-004). The
--    accession is a gapless sequence; the label carries no full name.
--  * referral — outbound referral lifecycle: sent → accepted/declined →
--    feedback → closed (ORD-008), linked to its source service request.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE clinical.order_set (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinical.order_set_item (
  id           uuid PRIMARY KEY,
  set_code     text NOT NULL REFERENCES clinical.order_set(code),
  category     text NOT NULL,
  code         text NOT NULL,
  priority     text NOT NULL DEFAULT 'routine',
  indication   text
);
CREATE INDEX order_set_item_set_idx ON clinical.order_set_item (set_code);

CREATE SEQUENCE clinical.specimen_accession_seq START 1;

CREATE TABLE clinical.specimen (
  id                  uuid PRIMARY KEY,
  accession           text UNIQUE NOT NULL,
  service_request_id  uuid NOT NULL REFERENCES clinical.service_request(id),
  patient_id          uuid NOT NULL REFERENCES identity.patient(id),
  collected_on        date NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinical.referral (
  id                  uuid PRIMARY KEY,
  service_request_id  uuid REFERENCES clinical.service_request(id),
  patient_id          uuid NOT NULL REFERENCES identity.patient(id),
  target_facility     text NOT NULL,
  reason              text,
  status              text NOT NULL DEFAULT 'sent', -- sent|accepted|declined|closed
  feedback            text,
  sent_by             uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_open_idx ON clinical.referral (status) WHERE status <> 'closed';

COMMIT;
