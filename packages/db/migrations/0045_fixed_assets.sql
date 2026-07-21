-- ---------------------------------------------------------------------------
-- 0045 Fixed-asset register (FIN-008)
--
-- Capitalised assets with their cost, salvage value and useful life. Depreciation
-- (straight-line) and net book value are DERIVED as-of a date (never a stored,
-- editable total). Disposal records proceeds so a gain/loss versus net book value
-- can be reported.
-- ---------------------------------------------------------------------------

CREATE TABLE finance.fixed_asset (
  id                 uuid PRIMARY KEY,
  reference          text UNIQUE NOT NULL,
  name               text NOT NULL,
  category           text,
  cost_minor         bigint NOT NULL CHECK (cost_minor >= 0),
  salvage_minor      bigint NOT NULL DEFAULT 0 CHECK (salvage_minor >= 0),
  useful_life_months integer NOT NULL CHECK (useful_life_months > 0),
  acquired_on        date NOT NULL,
  status             text NOT NULL DEFAULT 'active', -- active | disposed
  disposed_on        date,
  disposal_proceeds_minor bigint,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (salvage_minor <= cost_minor)
);
