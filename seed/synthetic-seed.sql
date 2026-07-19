-- synthetic-seed.sql — CLEARLY SYNTHETIC demo data only (pack §1, prompt §1/§7).
-- NEVER derived from the source workbook or any real patient. Safe for dev,
-- training and non-production. Names below are obviously fictional.
--
-- Apply AFTER migrations. UUIDs are fixed literals for deterministic tests.

BEGIN;

-- --- Chart of accounts (subset aligned to posting-rules.ts ACCOUNTS) ---------
INSERT INTO finance.account (code, name, type) VALUES
  ('1000-CASH', 'Cash drawer', 'asset'),
  ('1010-BANK-CLEARING', 'Bank clearing', 'asset'),
  ('1020-MM-CLEARING', 'Mobile money clearing', 'asset'),
  ('1200-PATIENT-AR', 'Patient accounts receivable', 'asset'),
  ('1300-INVENTORY', 'Inventory', 'asset'),
  ('2100-SUPPLIER-AP', 'Supplier accounts payable', 'liability'),
  ('2200-PATIENT-DEPOSIT', 'Patient deposits', 'liability'),
  ('4000-SERVICE-REVENUE', 'Service revenue', 'revenue'),
  ('4010-MEDICINE-REVENUE', 'Medicine revenue', 'revenue'),
  ('5000-COGS', 'Cost of goods sold', 'expense'),
  ('6900-CASH-OVER-SHORT', 'Cash over/short', 'expense'),
  ('6910-BAD-DEBT', 'Bad debt expense', 'expense');

INSERT INTO finance.financial_period (id, status) VALUES ('2026-07', 'open');

-- --- Fee schedule (effective-dated) -----------------------------------------
INSERT INTO billing.fee_version (service_code, version, effective_from, effective_to, standard_minor, min_minor, max_minor, tax_rate_bps, currency) VALUES
  ('CONSULT-GP', 1, '2026-01-01', '2026-07-01', 1000, 800, 1500, NULL, 'USD'),
  ('CONSULT-GP', 2, '2026-07-01', NULL, 1200, 1000, 1800, 1500, 'USD'),
  ('DRESSING',   1, '2026-01-01', NULL,  500,  400,  900, NULL, 'USD');

-- --- Product + lots (synthetic medicines) -----------------------------------
INSERT INTO inventory.product (sku, name, category, base_unit, controlled, reorder_min, reorder_max) VALUES
  ('AMOX-500', 'Amoxicillin 500mg capsule (SYNTHETIC)', 'antibiotic', 'capsule', false, 200, 1000),
  ('PARA-500', 'Paracetamol 500mg tablet (SYNTHETIC)', 'analgesic', 'tablet', false, 500, 2000);

INSERT INTO inventory.lot (id, sku, expiry_date, status, unit_cost_minor, supplier) VALUES
  ('00000000-0000-7000-8000-000000000a01', 'AMOX-500', '2026-09-01', 'available', 10, 'Synthetic Supplier A'),
  ('00000000-0000-7000-8000-000000000a02', 'AMOX-500', '2026-08-01', 'available', 12, 'Synthetic Supplier A'),
  ('00000000-0000-7000-8000-000000000b01', 'PARA-500', '2027-01-01', 'available', 3,  'Synthetic Supplier B');

INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES
  ('00000000-0000-7000-8000-000000000c01', 'AMOX-500', '00000000-0000-7000-8000-000000000a01', 'MAIN', 'receipt', 1000, 'seed'),
  ('00000000-0000-7000-8000-000000000c02', 'AMOX-500', '00000000-0000-7000-8000-000000000a02', 'MAIN', 'receipt',  500, 'seed'),
  ('00000000-0000-7000-8000-000000000c03', 'PARA-500', '00000000-0000-7000-8000-000000000b01', 'MAIN', 'receipt', 2000, 'seed');

-- --- A couple of clearly-fictional patients (for demo/training only) ----------
INSERT INTO identity.patient (id, mrn, given_name, family_name, date_of_birth, sex, phone, sensitivity, site_id) VALUES
  ('00000000-0000-7000-8000-000000000101', 'SCC-000101', 'Testpatient', 'Alpha', '1990-05-01', 'F', '+263 771 000 001', 'normal', NULL),
  ('00000000-0000-7000-8000-000000000102', 'SCC-000102', 'Sampleperson', 'Bravo', '1985-11-20', 'M', '+263 772 000 002', 'normal', NULL);

COMMIT;
