-- ---------------------------------------------------------------------------
-- 0016 manual journal + close loop (FIN-003, FIN-004)
--
-- FIN-003: a controlled manual journal is drafted by a maker and posted only by
-- a different checker (maker-checker, BR-011), with attachments for evidence. It
-- never edits an existing batch; approval creates a normal balanced batch.
-- FIN-004: equity accounts for the period-close loop (retained earnings +
-- income summary) so temporary accounts can be closed at month end.
-- ---------------------------------------------------------------------------

INSERT INTO finance.account (code, name, type) VALUES
  ('3000-RETAINED-EARNINGS', 'Retained earnings', 'equity'),
  ('3900-INCOME-SUMMARY', 'Income summary', 'equity')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE finance.manual_journal (
  id            uuid PRIMARY KEY,
  memo          text NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  period_id     text NOT NULL,
  status        text NOT NULL DEFAULT 'draft',   -- draft | posted | rejected
  lines         jsonb NOT NULL,                   -- [{accountCode, debitMinor, creditMinor, memo?}]
  attachments   jsonb NOT NULL DEFAULT '[]',      -- [{name, ref}] — evidence references (no blobs)
  maker_id      uuid NOT NULL,
  made_at       timestamptz NOT NULL DEFAULT now(),
  checker_id    uuid,
  checked_at    timestamptz,
  reject_reason text,
  batch_id      uuid REFERENCES finance.journal_batch(id)  -- set when posted
);

CREATE INDEX manual_journal_status_idx ON finance.manual_journal (status, made_at);
