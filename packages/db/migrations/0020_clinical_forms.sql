-- ---------------------------------------------------------------------------
-- 0020 versioned structured clinical forms (EHR-003)
--
-- Clinical content is captured through structured forms whose definition is
-- versioned and effective-dated. An encounter records which form + version it
-- used so a later revision never changes what was recorded; signing validates the
-- content against that form version.
-- ---------------------------------------------------------------------------

CREATE TABLE clinical.form_definition (
  form_code      text NOT NULL,
  version        integer NOT NULL,
  title          text NOT NULL,
  schema         jsonb NOT NULL,               -- [{key,label,type,required?,options?}]
  effective_from date NOT NULL,
  effective_to   date,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_code, version)
);

-- Which form (and version) an encounter was captured on.
ALTER TABLE clinical.encounter ADD COLUMN form_code text;

-- A starter HEAP form (History/Examination/Assessment/Plan), v1.
INSERT INTO clinical.form_definition (form_code, version, title, schema, effective_from) VALUES
  ('HEAP', 1, 'History/Examination/Assessment/Plan',
   '[{"key":"history","label":"History","type":"text","required":true},
     {"key":"examination","label":"Examination","type":"text"},
     {"key":"assessment","label":"Assessment","type":"text","required":true},
     {"key":"plan","label":"Plan","type":"text","required":true},
     {"key":"severity","label":"Severity","type":"code","options":["mild","moderate","severe"]}]'::jsonb,
   DATE '2026-01-01');
