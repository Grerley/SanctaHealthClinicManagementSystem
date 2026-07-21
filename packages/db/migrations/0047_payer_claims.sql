-- ---------------------------------------------------------------------------
-- 0047 Payer coverage, pre-auth & claims (BIL-011, optional)
--
-- Optional third-party-payer support: a patient may hold coverage with a payer;
-- services can be pre-authorised; an invoice can be claimed and the payer's
-- remittance recorded. A paid claim settles through the normal payment path (a
-- payer bank payment allocated to the invoice), so the ledger and debtor balance
-- stay correct — claims never post a shadow balance.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE billing.payer (
  id          uuid PRIMARY KEY,
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing.coverage (
  id             uuid PRIMARY KEY,
  patient_id     uuid NOT NULL REFERENCES identity.patient(id),
  payer_id       uuid NOT NULL REFERENCES billing.payer(id),
  member_number  text NOT NULL,
  plan           text,
  priority       integer NOT NULL DEFAULT 1,   -- 1 = primary
  effective_from date NOT NULL,
  effective_to   date,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coverage_patient_idx ON billing.coverage (patient_id, priority);

CREATE TABLE billing.preauth (
  id            uuid PRIMARY KEY,
  reference     text UNIQUE NOT NULL,
  patient_id    uuid NOT NULL REFERENCES identity.patient(id),
  payer_id      uuid NOT NULL REFERENCES billing.payer(id),
  service_code  text NOT NULL,
  status        text NOT NULL DEFAULT 'requested', -- requested|approved|declined
  authorisation text,
  note          text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);

CREATE TABLE billing.claim (
  id              uuid PRIMARY KEY,
  claim_number    text UNIQUE NOT NULL,
  invoice_id      uuid NOT NULL REFERENCES billing.invoice(id),
  coverage_id     uuid NOT NULL REFERENCES billing.coverage(id),
  payer_id        uuid NOT NULL REFERENCES billing.payer(id),
  status          text NOT NULL DEFAULT 'submitted', -- submitted|accepted|rejected|paid
  submitted_minor bigint NOT NULL,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE INDEX claim_invoice_idx ON billing.claim (invoice_id);

CREATE TABLE billing.claim_remittance (
  id            uuid PRIMARY KEY,
  claim_id      uuid NOT NULL REFERENCES billing.claim(id),
  paid_minor    bigint NOT NULL DEFAULT 0,
  adjustment_minor bigint NOT NULL DEFAULT 0,   -- disallowed/written-down amount
  payment_id    uuid REFERENCES billing.payment(id), -- the settling payer payment, if paid
  reason        text,
  remitted_at   timestamptz NOT NULL DEFAULT now()
);

COMMIT;
