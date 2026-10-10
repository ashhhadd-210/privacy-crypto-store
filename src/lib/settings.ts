/**
 * Store settings: the handful of values the client changes from the admin.
 *
 * Stored as JSON in the `settings` table, one row per key. Read through a
 * short-lived cache so every page can show the store name without a query,
 * and invalidated the moment the admin saves.
 */

import type { Kysely, Transaction } from 'kysely';

import { type Database, getDb } from './db.js';

export interface StoreSettings {
  store_name: string;
  currency: string;
  shipping_flat_cents: number;
  retention_days: number;
  purge_enabled: boolean;
  export_before_purge: boolean;
  /** Shipped orders count as delivered (complete) this many days after shipping. */
  complete_after_days: number;
}

export const DEFAULTS: StoreSettings = {
  store_name: '',
  currency: 'USD',
  shipping_flat_cents: 0,
  retention_days: 30,
  purge_enabled: true,
  export_before_purge: true,
  complete_after_days: 14,
};

const CACHE_MS = 15_000;
let cache: { at: number; value: StoreSettings } | null = null;

function coerce(key: keyof StoreSettings, raw: unknown): StoreSettings[typeof key] | undefined {
  const d = DEFAULTS[key];
  if (typeof d === 'number') return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  if (typeof d === 'boolean') return typeof raw === 'boolean' ? raw : undefined;
  return typeof raw === 'string' ? raw : undefined;
}

export async function getSettings(db: Kysely<Database> | Transaction<Database> = getDb()): Promise<StoreSettings> {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await db.selectFrom('settings').select(['key', 'value']).execute();
  const value: StoreSettings = { ...DEFAULTS };
  for (const row of rows) {
    const key = row.key as keyof StoreSettings;
    if (!(key in DEFAULTS)) continue;
    const v = coerce(key, row.value);
    if (v !== undefined) Object.assign(value, { [key]: v });
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(
  db: Kysely<Database> | Transaction<Database>,
  changes: Partial<StoreSettings>,
): Promise<(keyof StoreSettings)[]> {
  const before = await getSettings(db);
  const changed: (keyof StoreSettings)[] = [];
  for (const [key, v] of Object.entries(changes) as [keyof StoreSettings, StoreSettings[keyof StoreSettings]][]) {
    if (v === undefined || before[key] === v) continue;
    await db
      .insertInto('settings')
      .values({ key, value: JSON.stringify(v) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(v), updated_at: new Date() }))
      .execute();
    changed.push(key);
  }
  invalidateSettings();
  return changed;
}

export function invalidateSettings(): void {
  cache = null;
}
