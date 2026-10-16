-- 007_order_breakdown.sql
--
-- Orders remember how their total was reached, so every page and email can
-- show it plainly ("$2.00 each, normally $5.00"; "Order discount (20%)";
-- "Discount code"). Before this, a correct order could look wrong: the line
-- showed only the bulk price and the discount was one unexplained number.
--
-- discount_cents stays the total taken off (order discount + code). Orders
-- placed before this migration keep zeros here and are shown as a single
-- "Discount" line, exactly as before.

BEGIN;

ALTER TABLE order_items
    ADD COLUMN base_price_cents INTEGER CHECK (base_price_cents >= 0);  -- normal price when a bulk price applied

ALTER TABLE orders
    ADD COLUMN order_discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK (order_discount_cents >= 0),
    ADD COLUMN order_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (order_discount_percent BETWEEN 0 AND 100),
    ADD COLUMN code_discount_cents    INTEGER NOT NULL DEFAULT 0 CHECK (code_discount_cents >= 0);

COMMIT;
