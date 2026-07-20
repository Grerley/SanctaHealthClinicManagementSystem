-- ---------------------------------------------------------------------------
-- 0036 related persons, guardians & households (PAT-005)
--
-- A patient may have related persons — guardians (with authority), emergency
-- contacts and household members. Guardianship and emergency-contact status are
-- explicit flags so consent/notification rules can rely on them.
-- ---------------------------------------------------------------------------

CREATE TABLE identity.related_person (
  id                  uuid PRIMARY KEY,
  patient_id          uuid NOT NULL REFERENCES identity.patient(id),
  name                text NOT NULL,
  relationship        text NOT NULL,          -- mother | father | guardian | spouse | child | sibling | other
  is_guardian         boolean NOT NULL DEFAULT false,
  is_emergency_contact boolean NOT NULL DEFAULT false,
  phone               text,
  household_id        uuid,
  related_patient_id  uuid REFERENCES identity.patient(id), -- when the relation is also a registered patient
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX related_person_patient_idx ON identity.related_person (patient_id);
CREATE INDEX related_person_household_idx ON identity.related_person (household_id);
