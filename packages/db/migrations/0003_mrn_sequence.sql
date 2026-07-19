-- 0003_mrn_sequence.sql — controlled medical-record-number sequence (PAT-001).
-- The durable patient id is a UUID; the MRN is a separate human-readable series.
-- Starts high to avoid colliding with the synthetic seed's SCC-0001xx records.

BEGIN;
CREATE SEQUENCE IF NOT EXISTS identity.mrn_seq START 100000;
COMMIT;
