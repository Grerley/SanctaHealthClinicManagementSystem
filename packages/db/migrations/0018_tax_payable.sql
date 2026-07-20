-- ---------------------------------------------------------------------------
-- 0018 tax payable account (BIL-001) — the fee schedule carries a tax rate, so
-- priced charges split the tax into a liability rather than folding it into
-- revenue. Versioned like every other account (FIN-001).
-- ---------------------------------------------------------------------------

INSERT INTO finance.account (code, name, type) VALUES
  ('2300-TAX-PAYABLE', 'Tax payable', 'liability')
ON CONFLICT (code) DO NOTHING;

INSERT INTO finance.account_version (id, code, version, name, type, active, effective_from)
SELECT gen_random_uuid(), '2300-TAX-PAYABLE', 1, 'Tax payable', 'liability', true, DATE '2026-01-01'
WHERE NOT EXISTS (SELECT 1 FROM finance.account_version WHERE code = '2300-TAX-PAYABLE');
