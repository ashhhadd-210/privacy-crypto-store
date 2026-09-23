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

export interface ProductImagesTable {
  id: Generated<string>;
  product_id: string;
  /** Relative path under src/public, e.g. "placeholder/product-01.svg". */
  path: string;
  alt: Generated<string>;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
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
