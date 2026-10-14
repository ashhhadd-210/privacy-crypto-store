/**
 * Bulk prices and discounts by order total (client request, 14 Oct).
 *
 *   Bulk price:      per product, "buy at least N, pay X each". The highest
 *                    tier the quantity reaches sets the unit price.
 *   Order discount:  store-wide, "orders of at least $A get P% off", worked
 *                    out on the items after bulk prices. The highest tier the
 *                    order reaches applies; tiers do not add up.
 *   Discount codes:  still work, on top: the code applies to what is left
 *                    after the order discount.
 *
 * All rules here are pure functions, so the cart page, the checkout page and
 * the order transaction cannot disagree about a price.
 */

import type { Kysely, Transaction } from 'kysely';

import type { Database } from './db.js';
import { MAX_QTY } from './cart.js';
import { parsePrice, priceInput } from './product-form.js';
import type { StoreSettings } from './settings.js';

export const MAX_TIERS = 3;

export interface PriceTier {
  minQty: number;
  priceCents: number;
}

/** Unit price for `qty` items: the highest tier reached, else the normal price. */
export function unitPrice(basePriceCents: number, tiers: PriceTier[], qty: number): number {
  let price = basePriceCents;
  let reached = 0;
  for (const t of tiers) {
    if (qty >= t.minQty && t.minQty > reached) {
      price = t.priceCents;
      reached = t.minQty;
    }
  }
  return Math.min(price, basePriceCents);
}

/** Bulk tiers for several products in one query, each list sorted by quantity. */
export async function tiersFor(
  productIds: string[],
  db: Kysely<Database> | Transaction<Database>,
): Promise<Map<string, PriceTier[]>> {
  const out = new Map<string, PriceTier[]>();
  if (productIds.length === 0) return out;
  const rows = await db
    .selectFrom('product_price_tiers')
    .select(['product_id', 'min_qty', 'price_cents'])
    .where('product_id', 'in', productIds)
    .orderBy('min_qty')
    .execute();
  for (const r of rows) {
    const list = out.get(r.product_id) ?? [];
    list.push({ minQty: r.min_qty, priceCents: r.price_cents });
    out.set(r.product_id, list);
  }
  return out;
}

export interface TierRow {
  qty: string;
  price: string;
}

/**
 * The admin form's bulk-price rows. Empty rows are ignored. One message for
 * the whole set: the rows only make sense together.
 */
export function parseTiers(
  body: Record<string, unknown>,
  basePriceCents: number | null,
): { rows: TierRow[]; tiers: PriceTier[]; error: string | null } {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, 12) : '');
  const rows: TierRow[] = [];
  for (let i = 1; i <= MAX_TIERS; i++) rows.push({ qty: str(`tier_qty_${i}`), price: str(`tier_price_${i}`) });

  const tiers: PriceTier[] = [];
  for (const r of rows) {
    if (r.qty === '' && r.price === '') continue;
    if (r.qty === '' || r.price === '') return { rows, tiers: [], error: 'Fill in both the quantity and the price on each bulk price row, or leave both empty.' };
    const qty = Number(r.qty);
    if (!Number.isInteger(qty) || qty < 2 || qty > MAX_QTY) return { rows, tiers: [], error: `Bulk quantities are whole numbers from 2 to ${MAX_QTY}.` };
    const cents = parsePrice(r.price);
    if (cents === null) return { rows, tiers: [], error: 'Enter bulk prices like 20 or 19.50.' };
    if (basePriceCents !== null && cents >= basePriceCents) return { rows, tiers: [], error: 'Each bulk price must be lower than the normal price.' };
    tiers.push({ minQty: qty, priceCents: cents });
  }
  tiers.sort((a, b) => a.minQty - b.minQty);
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i]!.minQty === tiers[i - 1]!.minQty) return { rows, tiers: [], error: 'Each bulk price row needs a different quantity.' };
    if (tiers[i]!.priceCents >= tiers[i - 1]!.priceCents) return { rows, tiers: [], error: 'Larger quantities should have a lower price each.' };
  }
  return { rows, tiers, error: null };
}

/** Rows for the form from saved tiers, padded to MAX_TIERS. */
export function tierRows(tiers: PriceTier[]): TierRow[] {
  const rows = tiers.map((t) => ({ qty: String(t.minQty), price: priceInput(t.priceCents) }));
  while (rows.length < MAX_TIERS) rows.push({ qty: '', price: '' });
  return rows;
}

// --- discounts by order total ---------------------------------------------------

export interface SpendTier {
  overCents: number;
  percent: number;
}

type SpendSettings = Pick<
  StoreSettings,
  'spend1_over_cents' | 'spend1_percent' | 'spend2_over_cents' | 'spend2_percent' | 'spend3_over_cents' | 'spend3_percent'
>;

/** The configured order-total tiers, valid ones only, lowest first. */
export function spendTiers(s: SpendSettings): SpendTier[] {
  return [
    { overCents: s.spend1_over_cents, percent: s.spend1_percent },
    { overCents: s.spend2_over_cents, percent: s.spend2_percent },
    { overCents: s.spend3_over_cents, percent: s.spend3_percent },
  ]
    .filter((t) => t.overCents > 0 && t.percent > 0)
    .sort((a, b) => a.overCents - b.overCents);
}

/** Percent off for an order whose items come to `itemsCents`; 0 if none applies. */
export function spendPercent(tiers: SpendTier[], itemsCents: number): number {
  let pct = 0;
  for (const t of tiers) if (itemsCents >= t.overCents) pct = Math.max(pct, t.percent);
  return pct;
}

/** The next tier above the current amount, for "spend $X more for P% off". */
export function nextSpendTier(tiers: SpendTier[], itemsCents: number): SpendTier | null {
  const current = spendPercent(tiers, itemsCents);
  return tiers.find((t) => t.overCents > itemsCents && t.percent > current) ?? null;
}

/** Whole cents, rounded down: never more off than the percentage says. */
export function percentOff(cents: number, percent: number): number {
  return Math.floor((cents * percent) / 100);
}
