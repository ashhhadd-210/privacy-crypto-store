/**
 * Local preview only: bulk prices on the first sample product and example
 * discounts by order total, for screenshots. Never run against production.
 *
 *   npx tsx scripts/demo-discounts.ts on | off
 */

import 'dotenv/config';

import { closeDb, getDb } from '../src/lib/db.js';
import { invalidateSettings, saveSettings } from '../src/lib/settings.js';

if (process.env['NODE_ENV'] === 'production') throw new Error('demo data is for local preview only');

const db = getDb();
const p = await db.selectFrom('products').select('id').where('slug', '=', 'sample-01-standard').executeTakeFirstOrThrow();
await db.deleteFrom('product_price_tiers').where('product_id', '=', p.id).execute();
if (process.argv[2] === 'on') {
  await db.insertInto('product_price_tiers').values([
    { product_id: p.id, min_qty: 10, price_cents: 2000 },
    { product_id: p.id, min_qty: 25, price_cents: 1800 },
  ]).execute();
  await saveSettings(db, { spend1_over_cents: 20_000, spend1_percent: 10, spend2_over_cents: 40_000, spend2_percent: 20 });
} else {
  await saveSettings(db, { spend1_over_cents: 0, spend1_percent: 0, spend2_over_cents: 0, spend2_percent: 0 });
}
invalidateSettings();
console.log(`demo discounts ${process.argv[2]}`);
await closeDb();
