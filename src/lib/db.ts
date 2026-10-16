/**
 * Database access.
 *
 * Kysely over a pg pool. Typed query building, no ORM: the PII columns are
 * BYTEA that the application encrypts and decrypts itself, and an ORM's
 * conveniences (lazy relations, automatic serialisation, middleware) are
 * exactly the features that would quietly move a plaintext value somewhere it
 * should not go.
 *
 * Every query in this codebase is parameterised. There is no string-built SQL
 * anywhere outside the numbered migration files, which are ours and are not
 * fed by user input.
 */

import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';

import { loadConfig } from './config.js';

/**
 * Postgres returns BIGINT and NUMERIC as strings by default because they can
 * exceed JavaScript's safe integer range. Money in this schema is INTEGER
 * cents, so it arrives as a number already; these two parsers keep the few
 * remaining wide types explicit rather than surprising.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v); // keep exact, parse at use

// --- table types -----------------------------------------------------------
// Only the tables the application touches so far. Extended as routes land,
// rather than generated wholesale: a hand-written type is a second reader of
// the migration, and has already caught one column-name drift.

// `Generated<T>` marks a column the database fills in when it is not supplied:
// a DEFAULT or a generated key. Without it Kysely requires every column on
// every insert, which would mean hand-writing ids and timestamps the schema
// already produces correctly.
export interface AdminUsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: Generated<boolean>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Generated<Date>;
}

export interface AdminSessionsTable {
  /** SHA-256 of the cookie value, never the cookie value itself. See session.ts. */
  id: string;
  user_id: string;
  ip_hash: Buffer | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_at: Generated<Date>;
}

export interface ProductsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: Generated<string>;
  price_cents: number;
  stock: Generated<number>;
  track_stock: Generated<boolean>;
  active: Generated<boolean>;
  restricted_item: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProductPriceTiersTable {
  id: Generated<string>;
  product_id: string;
  min_qty: number;
  price_cents: number;
}

export interface ProductImagesTable {
  id: Generated<string>;
  product_id: string;
  /** Relative path under src/public, e.g. "placeholder/product-01.svg". */
  path: string;
  alt: Generated<string>;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
}

export interface PromotionsTable {
  id: Generated<string>;
  code: string;
  type: 'percent' | 'fixed';
  /** Percent 1–100, or cents. */
  value: number;
  min_subtotal_cents: Generated<number>;
  /** NULL = unlimited. */
  max_uses: number | null;
  used_count: Generated<number>;
  starts_at: Date | null;
  ends_at: Date | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface OrdersTable {
  id: Generated<string>;
  order_number: string;
  customer_id: string | null;
  status: Generated<'pending' | 'paid' | 'shipped' | 'complete' | 'expired' | 'cancelled' | 'refunded'>;
  email_enc: Buffer;
  email_bidx: Buffer;
  name_enc: Buffer;
  address_enc: Buffer;
  phone_enc: Buffer | null;
  subtotal_cents: number;
  discount_cents: Generated<number>;
  order_discount_cents: Generated<number>;
  order_discount_percent: Generated<number>;
  code_discount_cents: Generated<number>;
  shipping_cents: Generated<number>;
  total_cents: number;
  currency: Generated<string>;
  promotion_id: string | null;
  checkout_token: string | null;
  exported_at: Date | null;
  tracking_number: string | null;
  admin_note: string | null;
  paid_at: Date | null;
  shipped_at: Date | null;
  completed_at: Date | null;
  placed_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderItemsTable {
  id: Generated<string>;
  order_id: string;
  product_id: string | null;
  name_snapshot: string;
  unit_price_cents: number;
  /** Normal price when a bulk price applied; null otherwise (and on older orders). */
  base_price_cents: number | null;
  quantity: number;
  line_total_cents: number;
}

export interface CustomersTable {
  id: Generated<string>;
  email_enc: Buffer;
  email_bidx: Buffer;
  name_enc: Buffer | null;
  password_hash: string;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  created_at: Generated<Date>;
  last_login_at: Date | null;
}

export interface CustomerSessionsTable {
  /** SHA-256 of the cookie value, same rule as admin_sessions.id. */
  id: string;
  customer_id: string;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface PaymentsTable {
  id: Generated<string>;
  order_id: string;
  btcpay_invoice_id: string;
  status: Generated<'new' | 'processing' | 'settled' | 'expired' | 'invalid' | 'underpaid' | 'overpaid'>;
  amount_fiat_cents: number;
  currency_fiat: Generated<string>;
  amount_crypto: string | null;
  currency_crypto: string | null;
  exchange_rate: string | null;
  checkout_url: string | null;
  settled_at: Date | null;
  expires_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmailOutboxTable {
  id: Generated<string>;
  order_id: string;
  kind: string;
  attempts: Generated<number>;
  last_error: string | null;
  next_attempt_at: Generated<Date>;
  sent_at: Date | null;
  created_at: Generated<Date>;
}

export interface PaymentWebhooksTable {
  id: Generated<string>;
  invoice_id: string;
  event_type: string;
  delivery_id: string;
  payload: unknown;
  processed_at: Date | null;
  created_at: Generated<Date>;
}

/** What survives the purge: no names, addresses, emails or order numbers. */
export interface OrderAggregatesTable {
  id: Generated<string>;
  order_date: Date;
  total_cents: number;
  item_count: number;
  currency: Generated<string>;
  was_paid: boolean;
  created_at: Generated<Date>;
}

export interface PurgeRunsTable {
  id: Generated<string>;
  ran_at: Generated<Date>;
  retention_days: number;
  cutoff_at: Date;
  orders_purged: Generated<number>;
  customers_purged: Generated<number>;
  webhooks_purged: Generated<number>;
  /** 'schedule' | 'admin' | 'account-delete' */
  triggered_by: string;
  error: string | null;
}

export interface AuditLogTable {
  id: Generated<string>;
  actor: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
}

export interface Database {
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  settings: SettingsTable;
  products: ProductsTable;
  product_images: ProductImagesTable;
  product_price_tiers: ProductPriceTiersTable;
  promotions: PromotionsTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  customers: CustomersTable;
  customer_sessions: CustomerSessionsTable;
  payments: PaymentsTable;
  payment_webhooks: PaymentWebhooksTable;
  email_outbox: EmailOutboxTable;
  order_aggregates: OrderAggregatesTable;
  purge_runs: PurgeRunsTable;
  audit_log: AuditLogTable;
}

// --- connection ------------------------------------------------------------

let pool: pg.Pool | null = null;
let db: Kysely<Database> | null = null;

export function getDb(): Kysely<Database> {
  if (db !== null) return db;

  const config = loadConfig();

  pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    // A request that cannot get a connection should fail fast and return 503
    // rather than pile up behind an exhausted pool.
    connectionTimeoutMillis: 5_000,
  });

  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return db;
}

/** True if the database answers. Used by the health check the deploy relies on. */
export async function pingDb(): Promise<boolean> {
  try {
    await getDb().selectFrom('settings').select('key').limit(1).execute();
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (db !== null) {
    await db.destroy();
    db = null;
    pool = null;
  }
}
