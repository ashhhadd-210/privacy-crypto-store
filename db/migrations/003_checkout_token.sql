-- 003_checkout_token.sql
--
-- One order per checkout form. The form carries a random token; the order
-- stores it under a unique constraint, so a double-click, a retried request or
-- a back-button resubmit finds the order it already created instead of placing
-- a second one. Not personal data: it identifies a form, not a person.

BEGIN;

ALTER TABLE orders ADD COLUMN checkout_token UUID UNIQUE;

COMMENT ON COLUMN orders.checkout_token IS
    'Random per checkout form. Unique, so resubmitting the same form cannot create a second order.';

COMMIT;
