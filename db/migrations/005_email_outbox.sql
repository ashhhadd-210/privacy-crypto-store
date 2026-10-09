-- 005_email_outbox.sql
--
-- Order emails go through an outbox: a row is written in the same moment the
-- order changes, and a sender works through the rows. If the mail provider is
-- down, the payment or the shipment still succeeds and the email is retried.
--
-- Holds no personal data: the recipient and the content are built from the
-- order at send time, and the rows go with the order when it is purged.

BEGIN;

CREATE TABLE email_outbox (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind             TEXT        NOT NULL CHECK (kind IN ('received', 'paid', 'shipped')),
    attempts         INTEGER     NOT NULL DEFAULT 0,
    last_error       TEXT,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE sent_at IS NULL;

COMMIT;
