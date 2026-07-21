-- ---------------------------------------------------------------------------
-- 0043 Billing document prints & document index/OCR (BIL-007, DOC-006)
--
--  * billing_document_print — one row per issue of a receipt/invoice/statement.
--    The copy number distinguishes the original (1) from reprints (2+), so a
--    reprint is always visibly marked as a COPY (BIL-007).
--  * document_index — assistive index terms + OCR text attached to a document
--    reference. It is ADDITIVE: re-indexing appends a new version and never
--    overwrites the source file or its hash (DOC-006).
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE billing.document_print (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL,            -- receipt|invoice|statement
  ref_id       uuid NOT NULL,            -- payment/invoice id
  copy_number  integer NOT NULL,         -- 1 = original, 2+ = reprint
  printed_by   uuid,
  printed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_document_print_ref_idx ON billing.document_print (kind, ref_id);

CREATE TABLE clinical.document_index (
  id           uuid PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES clinical.document_reference(id),
  version      integer NOT NULL,         -- increments per re-index; older versions retained
  terms        text[] NOT NULL DEFAULT '{}',
  ocr_text     text,
  indexed_by   uuid,
  indexed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
CREATE INDEX document_index_terms_idx ON clinical.document_index USING gin (terms);

COMMIT;
