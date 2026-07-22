-- Documents on D1 (DOC-001/004/006/007): upload with policy validation (bad files
-- quarantined), disclosure-tracked opening, and additive re-indexing/OCR. The
-- document_reference table also carries the lifecycle columns (version, supersede,
-- legal hold, retention) so the lifecycle module ports as code only. `terms` is a
-- JSON array of text. Ported from the Postgres clinical schema.

CREATE TABLE IF NOT EXISTS clinical_document_reference (
  id                TEXT PRIMARY KEY,
  patient_id        TEXT,
  encounter_id      TEXT,
  doc_type          TEXT NOT NULL,
  filename          TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  security_label    TEXT NOT NULL DEFAULT 'normal',
  status            TEXT NOT NULL DEFAULT 'available',
  quarantine_reason TEXT,
  uploaded_by       TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  superseded_by     TEXT,
  legal_hold        INTEGER NOT NULL DEFAULT 0,
  retention_class   TEXT,
  retain_until      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_document_reference_patient_idx ON clinical_document_reference (patient_id);

CREATE TABLE IF NOT EXISTS clinical_disclosure (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES clinical_document_reference(id),
  user_id      TEXT NOT NULL,
  purpose      TEXT,
  disclosed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS clinical_disclosure_doc_idx ON clinical_disclosure (document_id);

CREATE TABLE IF NOT EXISTS clinical_document_index (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES clinical_document_reference(id),
  version     INTEGER NOT NULL,
  terms       TEXT NOT NULL DEFAULT '[]',
  ocr_text    TEXT,
  indexed_by  TEXT,
  indexed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (document_id, version)
);
