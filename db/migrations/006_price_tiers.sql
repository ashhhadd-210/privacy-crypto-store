-- 006_price_tiers.sql
--
-- Bulk prices: "buy at least N of this product, pay X each". Up to three per
-- product (the admin form enforces the count and the ordering). Product data,
-- not personal data: nothing here is purged.
--
-- Discounts by order total live in the settings table (spend1_over_cents ...),
-- so they need no table of their own.

BEGIN;

CREATE TABLE product_price_tiers (
    id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id   UUID    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    min_qty      INTEGER NOT NULL CHECK (min_qty BETWEEN 2 AND 999),
    price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
    UNIQUE (product_id, min_qty)
);

CREATE INDEX product_price_tiers_product_idx ON product_price_tiers (product_id);

COMMIT;
