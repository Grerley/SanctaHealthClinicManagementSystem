-- ---------------------------------------------------------------------------
-- 0029 external results + result corrections (ORD-007, ORD-009)
--
-- ORD-007: results arriving from an external source are matched to an order when
-- possible; unmatched ones queue for manual reconciliation.
-- ORD-009: corrections never delete the original — a corrected result is a new
-- row that supersedes the original, which is retained; cancellations keep the
-- order and record a reason (audited).
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.external_result (
  id                 uuid PRIMARY KEY,
  order_ref          text NOT NULL,           -- external order reference / code
  patient_id         uuid REFERENCES identity.patient(id),
  value              numeric,
  unit               text,
  abnormal           text NOT NULL DEFAULT 'normal',
  source             text,
  status             text NOT NULL DEFAULT 'unmatched', -- unmatched | matched
  service_request_id uuid REFERENCES clinical.service_request(id),
  received_at        timestamptz NOT NULL DEFAULT now(),
  reconciled_by      uuid,
  reconciled_at      timestamptz
);
CREATE INDEX external_result_status_idx ON clinical.external_result (status, received_at);

ALTER TABLE clinical.result ADD COLUMN status     text NOT NULL DEFAULT 'final'; -- final | corrected
ALTER TABLE clinical.result ADD COLUMN supersedes uuid REFERENCES clinical.result(id);
