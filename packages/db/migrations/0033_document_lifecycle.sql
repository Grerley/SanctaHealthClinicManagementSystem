-- ---------------------------------------------------------------------------
-- 0033 document generation snapshot, versioning & retention
-- (DOC-002/003/005)
--
-- DOC-002: a generated document retains an immutable content snapshot + hash.
-- DOC-003: documents version and supersede; entered-in-error and legal hold are
-- tracked; a held document is never disposed.
-- DOC-005: retention class + retain-until drive disposal eligibility; disposal is
-- audited and refused while on legal hold or before the retention date.
-- ---------------------------------------------------------------------------

ALTER TABLE clinical.document_reference ADD COLUMN version         integer NOT NULL DEFAULT 1;
ALTER TABLE clinical.document_reference ADD COLUMN supersedes      uuid REFERENCES clinical.document_reference(id);
ALTER TABLE clinical.document_reference ADD COLUMN legal_hold      boolean NOT NULL DEFAULT false;
ALTER TABLE clinical.document_reference ADD COLUMN retention_class text;
ALTER TABLE clinical.document_reference ADD COLUMN retain_until    date;
ALTER TABLE clinical.document_reference ADD COLUMN disposed_at     timestamptz;
ALTER TABLE clinical.document_reference ADD COLUMN snapshot        jsonb;  -- retained generated content (DOC-002)
-- status extended: available | superseded | entered_in_error | disposed
