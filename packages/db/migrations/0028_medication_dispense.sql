-- ---------------------------------------------------------------------------
-- 0028 medication instructions + dispensing status (MED-005/006)
--
-- Patient instructions are carried on the medication request for a legally
-- compliant printed prescription (MED-005); a dispensed timestamp lets the
-- dispensing worklist show only signed-and-undispensed requests (MED-006).
-- ---------------------------------------------------------------------------

ALTER TABLE clinical.medication_request ADD COLUMN instructions  text;
ALTER TABLE clinical.medication_request ADD COLUMN dispensed_at  timestamptz;
ALTER TABLE clinical.medication_request ADD COLUMN dispensed_by  uuid;
