-- ---------------------------------------------------------------------------
-- 0027 clinical handover / internal messages (EHR-012) + specialty form
-- templates (EHR-010)
--
-- EHR-012: a handover or internal message is addressed to a staff member and may
-- be linked to a patient and/or a task; the recipient acknowledges it.
-- EHR-010: specialty structured-form templates (child health, family planning,
-- wound care) as versioned form definitions (reuses the EHR-003 mechanism).
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.handover (
  id              uuid PRIMARY KEY,
  from_staff      uuid,
  to_staff        uuid NOT NULL,
  patient_id      uuid REFERENCES identity.patient(id),
  task_id         uuid,
  message         text NOT NULL,
  status          text NOT NULL DEFAULT 'open', -- open | acknowledged
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz
);
CREATE INDEX handover_recipient_idx ON clinical.handover (to_staff, status, created_at);

-- EHR-010 specialty templates as versioned forms (effective-dated like EHR-003).
INSERT INTO clinical.form_definition (form_code, version, title, schema, effective_from) VALUES
  ('CHILD-HEALTH', 1, 'Child health assessment',
   '[{"key":"weight_kg","label":"Weight (kg)","type":"number","required":true},
     {"key":"muac_mm","label":"MUAC (mm)","type":"number"},
     {"key":"immunisations_up_to_date","label":"Immunisations up to date","type":"boolean","required":true},
     {"key":"danger_signs","label":"IMCI danger signs","type":"text"}]'::jsonb,
   DATE '2026-01-01'),
  ('FAMILY-PLANNING', 1, 'Family planning consultation',
   '[{"key":"method","label":"Method","type":"code","options":["pill","injectable","implant","iud","condom","counselling"],"required":true},
     {"key":"counselling_done","label":"Counselling completed","type":"boolean","required":true},
     {"key":"follow_up_weeks","label":"Follow-up (weeks)","type":"number"}]'::jsonb,
   DATE '2026-01-01'),
  ('WOUND-CARE', 1, 'Wound care',
   '[{"key":"site","label":"Wound site","type":"text","required":true},
     {"key":"stage","label":"Stage","type":"code","options":["1","2","3","4","unstageable"]},
     {"key":"dressing","label":"Dressing applied","type":"text","required":true}]'::jsonb,
   DATE '2026-01-01');
