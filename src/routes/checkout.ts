/**
 * Guest checkout: name, delivery address and email. Nothing else is asked
 * for, and nothing else is kept.
 *
 * The three personal fields are encrypted before the INSERT is built, so they
 * never reach the database, its logs or its backups in readable form. The
 * email also gets a blind index, which is how a guest will find the order
 * again with its number (week 2). Nothing personal is put in a URL, a cookie
 * or a log line.
 *
 * The cart is re-priced inside the same transaction that writes the order,
 * with the product rows locked, so the order records exactly what was checked.
 * If anything changed since the cart page (stock, price, a hidden product, a
 * code that expired) the shopper is sent back to the cart, which says what
 * changed, rather than being charged for something they did not see.
 *
 * Stock is not taken here. The order is `pending` until paid; stock is taken
 * on payment and an unpaid order expires (week 3).
 */

import { randomInt, randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import { itemCount, readCart, readPromoCode, writeCart, writePromoCode } from '../lib/cart.js';
import { CUSTOMER_COOKIE, resolveCustomer } from '../lib/customer-auth.js';
import { blindIndex, encrypt, encryptAddress } from '../lib/crypto.js';
import { loadConfig } from '../lib/config.js';
import { type Database, getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { priceCart, unchanged } from '../lib/pricing.js';
import { BtcpayUnavailable } from '../lib/btcpay.js';
import { emitOrderEvent } from '../lib/order-events.js';
import { ensureInvoice } from '../lib/payments.js';
import { STATUS } from './lookup.js';
import { getSettings, shippingFor } from '../lib/settings.js';
import { lineViews, summaryView } from './cart.js';
import { ORDER_ITEM_COLUMNS, ORDER_SUMMARY_COLUMNS, itemView, totalsView } from '../lib/order-view.js';

const ORDER_COOKIE = 'order';

const text = (max: number) => z.string().trim().max(max);
const required = (max: number, message: string) => text(max).min(1, message);

const checkoutBody = z.object({
  token: z.string().uuid(),
  /** The total the shopper was shown. If today's total differs, they are shown it again. */
  expectedTotal: z.coerce.number().int().min(0),
  name: required(100, 'Please enter your name.'),
  email: text(254).email('Please enter a valid email address.'),
  line1: required(120, 'Please enter the first line of your address.'),
  line2: text(120).optional().default(''),
  city: required(80, 'Please enter your town or city.'),
  region: text(80).optional().default(''),
  postcode: required(20, 'Please enter your postcode or ZIP code.'),
  country: required(56, 'Please enter your country.'),
});
type CheckoutForm = z.infer<typeof checkoutBody>;
const FIELDS = ['name', 'email', 'line1', 'line2', 'city', 'region', 'postcode', 'country'] as const;

/** 32 characters with no 0/O or 1/I/L, so a number read over the phone is unambiguous. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function orderNumber(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `SO-${pick()}-${pick()}`;
}

async function shippingCents(db: Kysely<Database> | Transaction<Database>, itemsCents: number): Promise<number> {
  return shippingFor(await getSettings(db), itemsCents);
}

function orderCookie(reply: FastifyReply, orderId: string): FastifyReply {
  return reply.setCookie(ORDER_COOKIE, orderId, {
    path: '/checkout',
    httpOnly: true,
    sameSite: 'lax',
    secure: loadConfig().isProduction,
    signed: true,
  });
}

/** Thrown inside the transaction when the cart no longer matches the store. */
class CartChanged extends Error {}
/** Thrown when the total differs from the one on the page the shopper submitted. */
class TotalChanged extends Error {}

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  async function renderForm(
    request: FastifyRequest,
    reply: FastifyReply,
    form: Partial<CheckoutForm> & { token: string },
    errors: Partial<Record<(typeof FIELDS)[number], string>> = {},
    notice?: string,
  ) {
    const cart = readCart(request);
    const priced = await priceCart(cart, readPromoCode(request));
    if (priced.kept.size === 0) return reply.redirect('/cart', 303);
    // Send them to the cart to see what changed; it rewrites the cookie and explains.
    if (!unchanged(cart, priced) || priced.promoDropped) return reply.redirect('/cart', 303);

    const shipping = await shippingCents(db, priced.subtotalCents - priced.discountCents);
    const summary = summaryView(priced, shipping);
    return reply
      .code(Object.keys(errors).length > 0 || notice !== undefined ? 400 : 200)
      .header('cache-control', 'no-store')
      .view('shop/checkout.njk', {
        title: 'Checkout',
        bodyClass: 'shop',
        cartCount: itemCount(priced.kept),
        csrfToken: reply.generateCsrf(),
        form,
        errors,
        errorList: Object.values(errors),
        notice,
        expectedTotal: priced.subtotalCents - priced.discountCents + shipping,
        lines: await lineViews(priced.lines),
        ...summary,
      });
  }

  app.get('/checkout', async (request, reply) => {
    // The only thing an account contributes to checkout is the email. The
    // address is typed each time: accounts deliberately hold no address.
    const customer = await resolveCustomer(request.cookies[CUSTOMER_COOKIE]);
    return renderForm(request, reply, { token: randomUUID(), ...(customer ? { email: customer.email } : {}) });
  });

  app.post(
    '/checkout',
    {
      preValidation: app.csrfProtection,
      // Real shoppers submit once or twice. Anything more is a script.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const parsed = checkoutBody.safeParse(raw);

      if (!parsed.success) {
        const token = typeof raw['token'] === 'string' && z.string().uuid().safeParse(raw['token']).success
          ? raw['token']
          : randomUUID();
        const errors: Partial<Record<(typeof FIELDS)[number], string>> = {};
        for (const issue of parsed.error.issues) {
          const field = issue.path[0];
          if (typeof field === 'string' && (FIELDS as readonly string[]).includes(field) && !(field in errors)) {
            errors[field as (typeof FIELDS)[number]] = issue.message.startsWith('String must')
              ? 'That is too long.'
              : issue.message;
          }
        }
        // Echo back what they typed, so a single mistake does not mean retyping everything.
        const form: Partial<CheckoutForm> & { token: string } = { token };
        for (const f of FIELDS) {
          const v = raw[f];
          if (typeof v === 'string') form[f] = v.slice(0, 254);
        }
        const notice = Object.keys(errors).length === 0 ? 'Something went wrong with the form. Please try again.' : undefined;
        return renderForm(request, reply, form, errors, notice);
      }

      const input = parsed.data;
      const cart = readCart(request);
      const code = readPromoCode(request);
      const customer = await resolveCustomer(request.cookies[CUSTOMER_COOKIE]);

      let orderId: string;
      let created = false;
      try {
        orderId = await db.transaction().execute(async (trx) => {
          const existing = await trx
            .selectFrom('orders')
            .select('id')
            .where('checkout_token', '=', input.token)
            .executeTakeFirst();
          if (existing !== undefined) return existing.id;

          const priced = await priceCart(cart, code, trx, { lock: true });
          if (priced.kept.size === 0 || !unchanged(cart, priced) || priced.promoDropped) throw new CartChanged();

          const shipping = await shippingCents(trx, priced.subtotalCents - priced.discountCents);
          const discount = priced.discountCents;
          if (priced.subtotalCents - discount + shipping !== input.expectedTotal) throw new TotalChanged();

          const inserted = await trx
            .insertInto('orders')
            .values({
              order_number: orderNumber(),
              customer_id: customer?.id ?? null,
              email_enc: encrypt(input.email, 'orders.email'),
              email_bidx: blindIndex(input.email, 'orders.email'),
              name_enc: encrypt(input.name, 'orders.name'),
              address_enc: encryptAddress({
                line1: input.line1,
                ...(input.line2 !== '' ? { line2: input.line2 } : {}),
                city: input.city,
                ...(input.region !== '' ? { region: input.region } : {}),
                postcode: input.postcode,
                country: input.country,
              }),
              phone_enc: null,
              subtotal_cents: priced.subtotalCents,
              discount_cents: discount,
              order_discount_cents: priced.spendDiscountCents,
              order_discount_percent: priced.spendPercent,
              code_discount_cents: priced.promoDiscountCents,
              shipping_cents: shipping,
              total_cents: priced.subtotalCents - discount + shipping,
              promotion_id: priced.promotion?.id ?? null,
              checkout_token: input.token,
            })
            // A second submit racing the first waits on the product locks,
            // then lands here and finds the first one's order.
            .onConflict((oc) => oc.column('checkout_token').doNothing())
            .returning('id')
            .executeTakeFirst();

          if (inserted === undefined) {
            const row = await trx
              .selectFrom('orders')
              .select('id')
              .where('checkout_token', '=', input.token)
              .executeTakeFirstOrThrow();
            return row.id;
          }

          await trx
            .insertInto('order_items')
            .values(
              priced.lines.map((l) => ({
                order_id: inserted.id,
                product_id: l.productId,
                name_snapshot: l.name,
                unit_price_cents: l.unitPriceCents,
                base_price_cents: l.unitPriceCents < l.basePriceCents ? l.basePriceCents : null,
                quantity: l.qty,
                line_total_cents: l.lineTotalCents,
              })),
            )
            .execute();

          created = true;
          return inserted.id;
        });
      } catch (err) {
        if (err instanceof CartChanged) return reply.redirect('/cart', 303);
        if (err instanceof TotalChanged) {
          const { expectedTotal: _seen, ...form } = input;
          return renderForm(request, reply, form, {}, 'A price has changed since you opened this page. Please check the new total and place your order again.');
        }
        throw err;
      }

      writeCart(reply, new Map());
      writePromoCode(reply, null);
      orderCookie(reply, orderId).header('cache-control', 'no-store');
      if (created) await emitOrderEvent(db, orderId, 'received');

      // Straight on to payment. If BTCPay cannot be reached the order is safe
      // and the order page offers "Pay now" to try again.
      try {
        const url = await ensureInvoice(db, orderId, '/checkout/done');
        return reply.redirect(url ?? '/checkout/done', 303);
      } catch (err) {
        if (!(err instanceof BtcpayUnavailable)) throw err;
        request.log.warn({ reason: err.message }, 'invoice could not be created at checkout');
        return reply.redirect('/checkout/done?pay=unavailable', 303);
      }
    },
  );

  app.get<{ Querystring: { pay?: string } }>('/checkout/done', async (request, reply) => {
    const raw = request.cookies[ORDER_COOKIE];
    const unsigned = raw === undefined ? null : request.unsignCookie(raw);
    if (unsigned === null || !unsigned.valid || !unsigned.value) return reply.redirect('/', 303);

    const order = await db
      .selectFrom('orders')
      .select(['id', 'order_number', 'status', ...ORDER_SUMMARY_COLUMNS])
      .where('id', '=', unsigned.value)
      .executeTakeFirst();
    if (order === undefined) return reply.redirect('/', 303);

    const items = await db
      .selectFrom('order_items')
      .select([...ORDER_ITEM_COLUMNS])
      .where('order_id', '=', order.id)
      .execute();

    // Deliberately no name, email or address on this page: nothing to decrypt,
    // nothing for a shared computer's next user to read.
    return reply.header('cache-control', 'no-store').view('shop/checkout_done.njk', {
      title: order.status === 'paid' ? 'Payment confirmed' : 'Order received',
      bodyClass: 'shop',
      cartCount: 0,
      csrfToken: reply.generateCsrf(),
      orderNumber: order.order_number,
      status: STATUS[order.status]?.label ?? order.status,
      detail: STATUS[order.status]?.detail ?? '',
      canPay: order.status === 'pending',
      payUnavailable: request.query.pay === 'unavailable',
      summary: { items: items.map(itemView), totals: totalsView(order) },
      total: formatMoney(order.total_cents),
    });
  });
}

export { ORDER_COOKIE };
