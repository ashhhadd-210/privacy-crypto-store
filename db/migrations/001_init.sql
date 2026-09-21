-- 001_init.sql
-- Initial schema for the davmad619 privacy-first store.
-- Target: PostgreSQL 16.
--
-- DESIGN NOTES FOR WHOEVER MAINTAINS THIS AFTER HANDOVER
--
-- 1. Personally identifiable information is never stored in plain text. Every PII column is
--    BYTEA holding AES-256-GCM output laid out as: nonce(12) || ciphertext || tag(16).
--    Encryption happens in the application (src/lib/crypto.ts), not in the database, so the
--    database never sees the key and a stolen dump is useless on its own.
--
-- 2. Encrypted columns cannot be searched. Where we must look a value up (a guest checking
--    their order by email, or preventing duplicate accounts) there is a companion
--    "_bidx" column holding HMAC-SHA256(blind_index_key, lower(trim(value))). Equality
--    lookups run against the blind index. It leaks equality only, never the value.
--
-- 3. Orders are designed to be destroyed. The retention window in `settings` drives a purge
--    job that deletes the PII-bearing rows and leaves an anonymous row in `order_aggregates`
--    so the client keeps their sales history without keeping their customers' details.
--
-- 4. `products.restricted_item` is intentionally unused. It was promised to the client at no
--    cost so that adding a product needing a disclaimer later is a small change rather than a
--    schema migration. Do not remove it.

BEGIN;

-- ---------------------------------------------------------------------------
-- settings: single-row-per-key store for admin-configurable values.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       JSONB       NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE settings IS 'Admin-editable configuration. retention_days drives the purge job.';

INSERT INTO settings (key, value) VALUES
    ('retention_days',        '30'::jsonb),
    ('store_name',            '""'::jsonb),
    ('currency',              '"USD"'::jsonb),
    ('shipping_flat_cents',   '0'::jsonb),
    ('purge_enabled',         'true'::jsonb),
    ('export_before_purge',   'true'::jsonb);

-- ---------------------------------------------------------------------------
-- admin_users: the client, and nobody else. Small table by design.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT        NOT NULL UNIQUE,   -- not customer PII; kept readable for recovery
    password_hash  TEXT        NOT NULL,          -- argon2id
    totp_secret    TEXT,                          -- NULL until 2FA is enrolled
    totp_enabled   BOOLEAN     NOT NULL DEFAULT FALSE,
    failed_logins  INTEGER     NOT NULL DEFAULT 0,
    locked_until   TIMESTAMPTZ,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
    id          TEXT PRIMARY KEY,                 -- opaque random id, also the cookie value
    user_id     UUID        NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    ip_hash     BYTEA,                            -- hashed, never the raw IP
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX admin_sessions_user_idx    ON admin_sessions (user_id);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE products (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             TEXT        NOT NULL UNIQUE,
    name             TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    price_cents      INTEGER     NOT NULL CHECK (price_cents >= 0),
    stock            INTEGER     NOT NULL DEFAULT 0 CHECK (stock >= 0),
    track_stock      BOOLEAN     NOT NULL DEFAULT TRUE,
    active           BOOLEAN     NOT NULL DEFAULT FALSE,
    restricted_item  BOOLEAN     NOT NULL DEFAULT FALSE,  -- dormant. See design note 4.
    sort_order       INTEGER     NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX products_active_idx ON products (active, sort_order);

CREATE TABLE product_images (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    path        TEXT        NOT NULL,             -- relative path on disk, EXIF stripped on upload
    alt         TEXT        NOT NULL DEFAULT '',
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX product_images_product_idx ON product_images (product_id, sort_order);

-- ---------------------------------------------------------------------------
-- promotions: discount codes.
-- ---------------------------------------------------------------------------
CREATE TYPE promotion_type AS ENUM ('percent', 'fixed');

CREATE TABLE promotions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code               TEXT           NOT NULL UNIQUE,
    type               promotion_type NOT NULL,
    value              INTEGER        NOT NULL CHECK (value > 0),  -- percent 1-100, or cents
    min_subtotal_cents INTEGER        NOT NULL DEFAULT 0,
    max_uses           INTEGER,                                    -- NULL = unlimited
    used_count         INTEGER        NOT NULL DEFAULT 0,
    starts_at          TIMESTAMPTZ,
    ends_at            TIMESTAMPTZ,
    active             BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT promotions_percent_range
        CHECK (type <> 'percent' OR value BETWEEN 1 AND 100)
);

-- ---------------------------------------------------------------------------
-- customers: OPTIONAL accounts only. Guest orders never create a row here.
-- Self-deletion is a hard delete, which cascades to nothing because orders
-- deliberately hold their own copy of the delivery details.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_enc      BYTEA       NOT NULL,          -- AES-256-GCM
    email_bidx     BYTEA       NOT NULL UNIQUE,   -- HMAC-SHA256, for login and duplicate check
    name_enc       BYTEA,
    password_hash  TEXT        NOT NULL,          -- argon2id
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at  TIMESTAMPTZ
);

CREATE TABLE customer_sessions (
    id          TEXT PRIMARY KEY,
    customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id);
CREATE INDEX customer_sessions_expires_idx  ON customer_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- orders
--
-- An order carries its OWN encrypted copy of the delivery details, even when
-- placed by a logged-in customer. Two reasons: a guest order has no customer
-- row to point at, and an account holder deleting their account must not
-- destroy the shipping record of an order that is still in the post.
-- ---------------------------------------------------------------------------
CREATE TYPE order_status AS ENUM (
    'pending',      -- created, invoice not yet paid
    'paid',         -- BTCPay settled
    'shipped',
    'complete',
    'expired',      -- invoice expired unpaid
    'cancelled',
    'refunded'
);

CREATE TABLE orders (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number       TEXT         NOT NULL UNIQUE,  -- short human code, given to the customer
    customer_id        UUID         REFERENCES customers(id) ON DELETE SET NULL,  -- NULL = guest
    status             order_status NOT NULL DEFAULT 'pending',

    -- encrypted delivery details
    email_enc          BYTEA        NOT NULL,
    email_bidx         BYTEA        NOT NULL,  -- guest order lookup: order_number + email
    name_enc           BYTEA        NOT NULL,
    address_enc        BYTEA        NOT NULL,  -- encrypted JSON: line1, line2, city, region, postcode, country
    phone_enc          BYTEA,                  -- only if we end up collecting it

    -- money, all integer cents, no floats anywhere near currency
    subtotal_cents     INTEGER      NOT NULL CHECK (subtotal_cents >= 0),
    discount_cents     INTEGER      NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    shipping_cents     INTEGER      NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
    total_cents        INTEGER      NOT NULL CHECK (total_cents >= 0),
    currency           TEXT         NOT NULL DEFAULT 'USD',
    promotion_id       UUID         REFERENCES promotions(id) ON DELETE SET NULL,

    tracking_number    TEXT,
    admin_note         TEXT,                   -- staff-facing, must never contain customer PII

    placed_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    paid_at            TIMESTAMPTZ,
    shipped_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    exported_at        TIMESTAMPTZ,            -- last encrypted export that included this order
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX orders_status_idx     ON orders (status);
CREATE INDEX orders_placed_idx     ON orders (placed_at);
CREATE INDEX orders_email_bidx_idx ON orders (email_bidx);
CREATE INDEX orders_customer_idx   ON orders (customer_id);

CREATE TABLE order_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          UUID    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id        UUID    REFERENCES products(id) ON DELETE SET NULL,
    -- snapshots, so the order still reads correctly after a product is renamed or deleted
    name_snapshot     TEXT    NOT NULL,
    unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    line_total_cents  INTEGER NOT NULL CHECK (line_total_cents >= 0)
);

CREATE INDEX order_items_order_idx ON order_items (order_id);

-- ---------------------------------------------------------------------------
-- payments: one row per BTCPay invoice. An order can have more than one if the
-- first invoice expires and the customer retries.
-- ---------------------------------------------------------------------------
CREATE TYPE payment_status AS ENUM (
    'new', 'processing', 'settled', 'expired', 'invalid', 'underpaid', 'overpaid'
);

CREATE TABLE payments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           UUID           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    btcpay_invoice_id  TEXT           NOT NULL UNIQUE,
    status             payment_status NOT NULL DEFAULT 'new',
    amount_fiat_cents  INTEGER        NOT NULL,
    currency_fiat      TEXT           NOT NULL DEFAULT 'USD',
    amount_crypto      NUMERIC(24, 12),
    currency_crypto    TEXT,                       -- 'BTC', 'BTC-LightningNetwork', etc.
    exchange_rate      NUMERIC(24, 8),
    checkout_url       TEXT,
    settled_at         TIMESTAMPTZ,
    expires_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX payments_order_idx  ON payments (order_id);
CREATE INDEX payments_status_idx ON payments (status);

-- Webhook deliveries are recorded separately and pruned aggressively. Keeping the
-- raw body lets us replay a missed settlement; keeping it forever is a liability.
CREATE TABLE payment_webhooks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id   TEXT        NOT NULL,
    event_type   TEXT        NOT NULL,
    delivery_id  TEXT        NOT NULL UNIQUE,   -- BTCPay's id, makes replay handling idempotent
    payload      JSONB       NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payment_webhooks_invoice_idx ON payment_webhooks (invoice_id);

-- ---------------------------------------------------------------------------
-- order_aggregates: what survives the purge.
-- No names, no addresses, no emails, no order numbers. Just enough for the
-- client to see what the business did in a month they no longer hold data for.
-- ---------------------------------------------------------------------------
CREATE TABLE order_aggregates (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_date   DATE        NOT NULL,
    total_cents  INTEGER     NOT NULL,
    item_count   INTEGER     NOT NULL,
    currency     TEXT        NOT NULL DEFAULT 'USD',
    was_paid     BOOLEAN     NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_aggregates_date_idx ON order_aggregates (order_date);

-- ---------------------------------------------------------------------------
-- purge_runs: evidence that retention actually happened. The client can show
-- this to anyone who asks, and it proves the job is alive.
-- ---------------------------------------------------------------------------
CREATE TABLE purge_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    retention_days    INTEGER     NOT NULL,
    cutoff_at         TIMESTAMPTZ NOT NULL,
    orders_purged     INTEGER     NOT NULL DEFAULT 0,
    customers_purged  INTEGER     NOT NULL DEFAULT 0,
    webhooks_purged   INTEGER     NOT NULL DEFAULT 0,
    triggered_by      TEXT        NOT NULL,   -- 'schedule' | 'admin' | 'account-delete'
    error             TEXT
);

-- ---------------------------------------------------------------------------
-- audit_log: admin actions. Deliberately holds no customer PII, so it is safe
-- to keep past the retention window.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor       TEXT        NOT NULL,   -- admin email, or 'system'
    action      TEXT        NOT NULL,   -- 'product.update', 'order.ship', 'settings.retention', ...
    entity      TEXT,
    entity_id   TEXT,
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_created_idx ON audit_log (created_at);
CREATE INDEX audit_log_action_idx  ON audit_log (action);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_touch BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER orders_touch   BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
