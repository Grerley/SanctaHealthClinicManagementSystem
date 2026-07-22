-- Synthetic demo seed so every screen renders content on a fresh database.
-- SYNTHETIC DATA ONLY — no real patients. Idempotent: fixed ids + INSERT OR IGNORE,
-- so re-applying (or re-running the deploy) never duplicates. This is what lets an
-- operator click through Patients / Dispense / Queue / Calendar / Command centre
-- immediately, exactly as the pre-migration demo did.

-- Patients (fictional names).
INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name, date_of_birth, sex) VALUES
  ('demo-pat-1', 'SCC-000001', 'Ada',   'Achebe',  '1984-03-11', 'female'),
  ('demo-pat-2', 'SCC-000002', 'Kwame', 'Boateng', '1991-07-02', 'male'),
  ('demo-pat-3', 'SCC-000003', 'Lena',  'Costa',   '2003-12-19', 'female');

-- Stock: a lot of amoxicillin with on-hand balance at MAIN (feeds Dispense + KPIs).
INSERT OR IGNORE INTO inventory_lot (id, sku, expiry_date, status, unit_cost_minor, supplier) VALUES
  ('demo-lot-1', 'AMOX-500', '2027-06-30', 'available', 12, 'Demo Pharma');
INSERT OR IGNORE INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES
  ('demo-mov-1', 'AMOX-500', 'demo-lot-1', 'MAIN', 'receipt', 250, 'seed');
INSERT OR IGNORE INTO inventory_stock_balance (lot_id, location, sku, on_hand) VALUES
  ('demo-lot-1', 'MAIN', 'AMOX-500', 250);

-- Queue: one patient checked in and waiting at reception.
INSERT OR IGNORE INTO flow_visit (id, patient_id, visit_number, status) VALUES
  ('demo-visit-1', 'demo-pat-1', 'V-demo-000001', 'open');
INSERT OR IGNORE INTO flow_queue_entry (id, visit_id, token, station, priority, status) VALUES
  ('demo-queue-1', 'demo-visit-1', 1, 'reception', 100, 'waiting');

-- Calendar: three slots today-ish for two providers (one booked, showing an MRN).
-- Dates are relative-free fixed samples; the Calendar screen lands on "today", so
-- these appear when the operator navigates to the seeded dates.
INSERT OR IGNORE INTO scheduling_slot (id, provider, starts_at, ends_at, status, room, service_code) VALUES
  ('demo-slot-1', 'Dr Osei',   '2026-07-22T09:00:00Z', '2026-07-22T09:20:00Z', 'booked', 'Room 1', 'GP'),
  ('demo-slot-2', 'Dr Osei',   '2026-07-22T09:20:00Z', '2026-07-22T09:40:00Z', 'open',   'Room 1', 'GP'),
  ('demo-slot-3', 'Dr Mensah', '2026-07-22T10:00:00Z', '2026-07-22T10:30:00Z', 'open',   'Room 2', 'ANC');
INSERT OR IGNORE INTO scheduling_appointment (id, slot_id, patient_id, service_code, status) VALUES
  ('demo-appt-1', 'demo-slot-1', 'demo-pat-2', 'GP', 'booked');
