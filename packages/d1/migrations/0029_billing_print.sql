-- Print/reprint of receipts, invoices and statements on D1 (BIL-007). Each issue
-- is recorded so a reprint is always visibly a COPY: the first print is the
-- original (copy 1); subsequent prints increment the copy number and the document
-- carries a COPY marker (domain billing-doc). Every issue is audited.

CREATE TABLE IF NOT EXISTS billing_document_print (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- receipt | invoice | statement
  ref_id      TEXT NOT NULL,          -- payment / invoice / patient id
  copy_number INTEGER NOT NULL,
  printed_by  TEXT,
  printed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- A given copy number is issued once per document (lock-free gate against a
-- concurrent reprint minting the same copy number).
CREATE UNIQUE INDEX IF NOT EXISTS billing_document_print_copy_uq ON billing_document_print (kind, ref_id, copy_number);
