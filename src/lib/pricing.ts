/**
 * Turns what a cart cookie asks for into what the store will actually sell,
 * at today's prices. The cart page and checkout both go through here, so a
 * rule about stock, visibility or discounts cannot apply in one and not the
 * other.
 */

import type { Kysely, Transaction } from 'kysely';

import { type Cart, MAX_QTY } from './cart.js';
import { type Database, getDb } from './db.js';
import { type Promotion, discountCents, findUsablePromotion } from './promo.js';

export interface PricedLine {
  productId: string;
  slug: string;
  name: string;
  unitPriceCents: number;
  qty: number;
  maxQty: number;
  lineTotalCents: number;
}

export interface PricedCart {
  /** The cart as the store will honour it. Differs from the input when something changed. */
  kept: Cart;
  lines: PricedLine[];
  notices: string[];
  subtotalCents: number;
  promotion: Promotion | null;
  /** A code was present but is no longer usable. */
  promoDropped: boolean;
  discountCents: number;
}

export async function priceCart(
  cart: Cart,
  code: string | null,
  db: Kysely<Database> | Transaction<Database> = getDb(),
  { lock = false } = {},
): Promise<PricedCart> {
  const ids = [...cart.keys()];
  let query = db
    .selectFrom('products')
    .select(['id', 'slug', 'name', 'price_cents', 'stock', 'track_stock'])
    .where('id', 'in', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'])
    .where('active', '=', true);
  // At checkout the rows are locked until the order is written, so two
  // checkouts cannot both pass the stock check on the last unit.
  if (lock) query = query.forUpdate();
  const rows = await query.execute();
  const byId = new Map(rows.map((r) => [r.id, r]));

  const kept: Cart = new Map();
  const notices: string[] = [];
  const lines: PricedLine[] = [];
  let unavailable = 0;
  let subtotalCents = 0;

  for (const [id, wanted] of cart) {
    const p = byId.get(id);
    if (p === undefined) {
      unavailable += 1;
      continue;
    }
    if (p.track_stock && p.stock <= 0) {
      notices.push(`${p.name} has sold out and was removed from your cart.`);
      continue;
    }
    const cap = p.track_stock ? Math.min(p.stock, MAX_QTY) : MAX_QTY;
    const qty = Math.min(wanted, cap);
    if (qty < wanted) notices.push(`Only ${p.stock} of ${p.name} left, so your quantity was reduced.`);
    kept.set(id, qty);
    subtotalCents += p.price_cents * qty;
    lines.push({
      productId: id,
      slug: p.slug,
      name: p.name,
      unitPriceCents: p.price_cents,
      qty,
      maxQty: cap,
      lineTotalCents: p.price_cents * qty,
    });
  }

  if (unavailable > 0) {
    notices.unshift(
      unavailable === 1
        ? 'An item in your cart is no longer available and was removed.'
        : `${unavailable} items in your cart are no longer available and were removed.`,
    );
  }

  const promotion = code === null ? null : await findUsablePromotion(code, new Date(), db);
  const promoDropped = code !== null && promotion === null;
  if (promoDropped) notices.push('Your discount code is no longer valid and was removed.');

  return {
    kept,
    lines,
    notices,
    subtotalCents,
    promotion,
    promoDropped,
    discountCents: promotion === null ? 0 : discountCents(promotion, subtotalCents),
  };
}

/** True when the store would sell exactly what the cookie asked for. */
export function unchanged(cart: Cart, priced: PricedCart): boolean {
  return priced.kept.size === cart.size && [...priced.kept].every(([id, qty]) => cart.get(id) === qty);
}
