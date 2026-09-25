/**
 * The cart page and the forms that change it.
 *
 * The cookie says what the visitor asked for; the database decides what they
 * get. Every render re-reads price, stock and `active`, so a product that sold
 * out, went hidden or changed price since it was added is corrected here, and
 * the visitor is told why. A hidden product is removed without being named,
 * for the same reason its URL 404s.
 *
 * Nothing is reserved. Stock is checked again at checkout and only taken when
 * a payment completes.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  type Cart,
  MAX_LINES,
  MAX_QTY,
  itemCount,
  readCart,
  readPromoCode,
  writeCart,
  writePromoCode,
} from '../lib/cart.js';
import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { type PricedCart, type PricedLine, priceCart, unchanged } from '../lib/pricing.js';
import { MAX_CODE_LENGTH, describe, findUsablePromotion, normalizeCode } from '../lib/promo.js';
import { imagesFor } from './shop.js';

/** Fixed messages chosen by code, so nothing from the query string is echoed. */
const MESSAGES: Record<string, string> = {
  added: 'Added to your cart.',
  limited: 'That is as many as we can sell you right now, so your quantity was capped.',
  full: `Your cart holds up to ${MAX_LINES} different products. Remove one to add another.`,
  code_applied: 'Discount code applied.',
  code_invalid: 'That code is not valid.',
  code_removed: 'Discount code removed.',
};

const addBody = z.object({
  slug: z.string().min(1).max(200),
  qty: z.coerce.number().int().min(1).max(MAX_QTY).default(1),
});
const updateBody = z.object({
  productId: z.string().uuid(),
  qty: z.coerce.number().int().min(0).max(MAX_QTY),
});
const removeBody = z.object({ productId: z.string().uuid() });
const promoBody = z.object({ code: z.string().max(200) });

function badRequest(): Error {
  return Object.assign(new Error('invalid cart request'), { statusCode: 400 });
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest();
  return result.data;
}

function done(reply: FastifyReply, cart: Cart, msg?: string): FastifyReply {
  return writeCart(reply, cart)
    .header('cache-control', 'no-store')
    .redirect(msg === undefined ? '/cart' : `/cart?msg=${msg}`, 303);
}

/** Lines as templates want them: formatted money and an image. */
export async function lineViews(lines: PricedLine[]) {
  const images = await imagesFor(lines.map((l) => l.productId));
  return lines.map((l) => {
    const image = images.get(l.productId);
    return {
      productId: l.productId,
      slug: l.slug,
      name: l.name,
      image: image === undefined ? '/placeholder/no-image.svg' : `/${image.path}`,
      imageAlt: image?.alt ?? '',
      unitPrice: formatMoney(l.unitPriceCents),
      lineTotal: formatMoney(l.lineTotalCents),
      qty: l.qty,
      maxQty: l.maxQty,
    };
  });
}

/** Subtotal, discount and total, formatted. Shipping is added by checkout. */
export function summaryView(priced: PricedCart, shippingCents = 0) {
  const promo = priced.promotion;
  const shortBy = promo === null ? 0 : promo.minSubtotalCents - priced.subtotalCents;
  return {
    subtotal: formatMoney(priced.subtotalCents),
    promo:
      promo === null
        ? null
        : {
            code: promo.code,
            label: describe(promo, formatMoney),
            discountCents: priced.discountCents,
            discount: formatMoney(priced.discountCents),
            shortBy: shortBy > 0 ? formatMoney(shortBy) : null,
          },
    shipping: formatMoney(shippingCents),
    total: formatMoney(priced.subtotalCents - priced.discountCents + shippingCents),
  };
}

export async function cartRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get<{ Querystring: { msg?: string } }>('/cart', async (request, reply) => {
    const cart = readCart(request);
    const priced = await priceCart(cart, readPromoCode(request));
    if (!unchanged(cart, priced)) writeCart(reply, priced.kept);
    if (priced.promoDropped) writePromoCode(reply, null);

    const msg = request.query.msg;
    return reply.header('cache-control', 'no-store').view('shop/cart.njk', {
      title: 'Your cart',
      bodyClass: 'shop',
      cartCount: itemCount(priced.kept),
      csrfToken: reply.generateCsrf(),
      message: msg !== undefined && Object.hasOwn(MESSAGES, msg) ? MESSAGES[msg] : undefined,
      notices: priced.notices,
      lines: await lineViews(priced.lines),
      ...summaryView(priced),
      maxCodeLength: MAX_CODE_LENGTH,
    });
  });

  app.post('/cart/add', { preValidation: app.csrfProtection }, async (request, reply) => {
    const body = parse(addBody, request.body);

    const product = await db
      .selectFrom('products')
      .select(['id', 'slug', 'stock', 'track_stock'])
      .where('slug', '=', body.slug)
      .where('active', '=', true)
      .executeTakeFirst();
    if (product === undefined) return reply.callNotFound();

    if (product.track_stock && product.stock <= 0) {
      return reply.redirect(`/p/${encodeURIComponent(product.slug)}`, 303);
    }

    const cart = readCart(request);
    if (!cart.has(product.id) && cart.size >= MAX_LINES) return done(reply, cart, 'full');

    const wanted = (cart.get(product.id) ?? 0) + body.qty;
    const cap = product.track_stock ? Math.min(product.stock, MAX_QTY) : MAX_QTY;
    const qty = Math.min(wanted, cap);
    cart.set(product.id, qty);
    return done(reply, cart, qty < wanted ? 'limited' : 'added');
  });

  app.post('/cart/update', { preValidation: app.csrfProtection }, async (request, reply) => {
    const body = parse(updateBody, request.body);
    const cart = readCart(request);
    if (!cart.has(body.productId)) return done(reply, cart);

    if (body.qty === 0) cart.delete(body.productId);
    else cart.set(body.productId, body.qty);
    // Stock is not checked here: the cart page does it on the redirect, and says so.
    return done(reply, cart);
  });

  // Tight limit per address: a code form is a guessing target.
  const guessLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/cart/promo', { preValidation: app.csrfProtection, config: guessLimit }, async (request, reply) => {
    const body = parse(promoBody, request.body);
    const promo = await findUsablePromotion(body.code);
    const cart = readCart(request);
    if (promo === null) return done(reply, cart, 'code_invalid');
    writePromoCode(reply, normalizeCode(promo.code));
    return done(reply, cart, 'code_applied');
  });

  app.post('/cart/promo/remove', { preValidation: app.csrfProtection }, async (request, reply) => {
    writePromoCode(reply, null);
    return done(reply, readCart(request), 'code_removed');
  });

  app.post('/cart/remove', { preValidation: app.csrfProtection }, async (request, reply) => {
    const body = parse(removeBody, request.body);
    const cart = readCart(request);
    cart.delete(body.productId);
    return done(reply, cart);
  });
}
