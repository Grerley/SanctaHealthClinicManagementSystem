-- ---------------------------------------------------------------------------
-- 0040 Prescribing protocol templates & medication administration (MED-004/009)
--
--  * rx_template / rx_template_item — reusable prescribing protocols/favourites.
--    Applying a template only PROPOSES lines; a clinician must confirm each
--    (which runs the normal allergy/override safety) before anything is
--    prescribed (MED-004). The template never auto-prescribes.
--  * medication_administration — the administration record (MAR): time, dose,
--    route, site, performer and given/not-given outcome per dose (MED-009).
--    Append-only history.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE clinical.rx_template (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinical.rx_template_item (
  id             uuid PRIMARY KEY,
  template_code  text NOT NULL REFERENCES clinical.rx_template(code),
  medicine_code  text NOT NULL,
  substance_code text NOT NULL,
  dose           text,
  route          text,
  frequency      text,
  duration_days  integer,
  quantity       integer,
  instructions   text
);
CREATE INDEX rx_template_item_tpl_idx ON clinical.rx_template_item (template_code);

CREATE TABLE clinical.medication_administration (
  id                uuid PRIMARY KEY,
  request_id        uuid NOT NULL REFERENCES clinical.medication_request(id),
  patient_id        uuid NOT NULL REFERENCES identity.patient(id),
  administered_at   timestamptz NOT NULL DEFAULT now(),
  dose              text,
  route             text,
  site              text,
  performer         uuid,
  status            text NOT NULL DEFAULT 'given', -- given | not_given
  reason            text,                          -- required when not_given
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'not_given' OR reason IS NOT NULL)
);
CREATE INDEX medication_administration_request_idx ON clinical.medication_administration (request_id, administered_at);

COMMIT;
