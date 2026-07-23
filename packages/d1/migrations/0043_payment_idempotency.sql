-- Idempotent payments on D1 (BR-006, safety scenario #8: a duplicate payment
-- retry must never double-post). A client sends a stable idempotency key with the
-- write; a partial UNIQUE index makes a replay of the same key a no-op that returns
-- the original payment instead of creating a second one.

ALTER TABLE billing_payment ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_idempotency_uq
  ON billing_payment (idempotency_key) WHERE idempotency_key IS NOT NULL;
