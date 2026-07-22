-- Document generation snapshot, versioning & retention on D1 (DOC-002/003/005).
-- Adds the columns the lifecycle needs to the existing document_reference: an
-- immutable content snapshot, the supersedes link, and the disposal timestamp.
-- Nothing is ever hard-deleted; disposal clears the snapshot but keeps metadata.

ALTER TABLE clinical_document_reference ADD COLUMN snapshot TEXT;
ALTER TABLE clinical_document_reference ADD COLUMN supersedes TEXT;
ALTER TABLE clinical_document_reference ADD COLUMN disposed_at TEXT;
