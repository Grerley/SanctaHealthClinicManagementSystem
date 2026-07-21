-- ---------------------------------------------------------------------------
-- 0046 Room & service on slots (APT-008)
--
-- The calendar can be viewed by day/week and grouped by provider, room or
-- service. Slots already carry the provider and time; add the room and service so
-- those calendar dimensions have a source. Both are optional reference strings.
-- ---------------------------------------------------------------------------

ALTER TABLE scheduling.slot ADD COLUMN room         text;
ALTER TABLE scheduling.slot ADD COLUMN service_code text;

CREATE INDEX slot_calendar_idx ON scheduling.slot (starts_at);
