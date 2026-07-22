-- Controlled manual journal with maker-checker on D1 (FIN-003, BR-011). A maker
-- drafts a balanced journal; a DIFFERENT checker posts it (segregation of duties)
-- through the shared posting choke point, or rejects it with a reason. Never edits
-- an existing batch. Ported from the Postgres finance schema. lines/attachments
-- are JSON text.

CREATE TABLE IF NOT EXISTS finance_manual_journal (
  id            TEXT PRIMARY KEY,
  memo          TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  period_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  lines         TEXT NOT NULL,
  attachments   TEXT NOT NULL DEFAULT '[]',
  maker_id      TEXT NOT NULL,
  made_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  checker_id    TEXT,
  checked_at    TEXT,
  reject_reason TEXT,
  batch_id      TEXT
);
CREATE INDEX IF NOT EXISTS finance_manual_journal_status_idx ON finance_manual_journal (status, made_at);
