/**
 * Guest order lookup: order number and email, together.
 *
 * Neither alone finds anything. The email is matched through its blind index,
 * never decrypted or compared as text, and it only ever travels in a POST
 * body, so it cannot end up in a URL, a browser history or an access log.
 *
 * A wrong email and an order number that does not exist get the same page, so
 * the form cannot be used to find out which numbers are real. The result shows
 * status, items and totals, and nothing personal: whoever is at the screen
 * proved they know an email, not that they may read an address.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { blindIndex } from '../lib/crypto.js';
import { itemCount, readCart } from '../lib/cart.js';
import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { ORDER_ITEM_COLUMNS, ORDER_SUMMARY_COLUMNS, itemView, totalsView } from '../lib/order-view.js';

export const STATUS: Record<string, { label: string; detail: string }> = {
  pending: { label: 'Awaiting payment', detail: 'We have your order. It will be prepared once the Bitcoin payment is confirmed.' },
  paid: { label: 'Paid', detail: 'Your payment is confirmed and your order is being prepared.' },
  shipped: { label: 'Shipped', detail: 'Your order is on its way.' },
  complete: { label: 'Complete', detail: 'This order is complete.' },
  expired: { label: 'Payment window expired', detail: 'No payment arrived in time, so this order was not processed. Nothing was charged.' },
  cancelled: { label: 'Cancelled', detail: 'This order was cancelled.' },
  refunded: { label: 'Refunded', detail: 'This order was refunded.' },
};

const NOT_FOUND = 'We could not find an order with that number and email. Check both and try again.';

const lookupBody = z.object({
  number: z.string().trim().min(1).max(20),
  email: z.string().trim().min(3).max(254),
});

export async function lookupRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  function form(request: Parameters<typeof readCart>[0], reply: FastifyReply, status: number, extra: object = {}) {
    return reply
      .code(status)
      .header('cache-control', 'no-store')
      .view('shop/order_lookup.njk', {
        title: 'Check an order',
        bodyClass: 'shop',
        cartCount: itemCount(readCart(request)),
        csrfToken: reply.generateCsrf(),
        ...extra,
      });
  }

  app.get<{ Querystring: { pay?: string } }>('/order', async (request, reply) =>
    form(request, reply, 200, request.query.pay === 'unavailable' ? { error: 'The payment page could not be opened just now. Please look up your order and try again in a moment.' } : {}),
  );

  app.post(
    '/order',
    {
      preValidation: app.csrfProtection,
      // Each attempt is a guess at a (number, email) pair. Five a minute is
      // plenty for someone mistyping their own; it is useless for guessing.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = lookupBody.safeParse(request.body ?? {});
      if (!parsed.success) return form(request, reply, 400, { error: NOT_FOUND });

      const number = parsed.data.number.toUpperCase();
      const order = await db
        .selectFrom('orders')
        .select(['id', 'order_number', 'status', ...ORDER_SUMMARY_COLUMNS, 'tracking_number', 'placed_at'])
        .where('order_number', '=', number)
        .where('email_bidx', '=', blindIndex(parsed.data.email, 'orders.email'))
        .executeTakeFirst();

      // Same status and same page for "no such order" and "wrong email".
      if (order === undefined) return form(request, reply, 200, { error: NOT_FOUND, number: parsed.data.number });

      const items = await db
        .selectFrom('order_items')
        .select([...ORDER_ITEM_COLUMNS])
        .where('order_id', '=', order.id)
        .execute();

      const status = STATUS[order.status] ?? { label: order.status, detail: '' };
      return form(request, reply, 200, {
        // Echoed into a hidden POST field only, so "Pay now" can find the order
        // again. It never goes into a URL.
        payEmail: order.status === 'pending' ? parsed.data.email : null,
        order: {
          number: order.order_number,
          placed: order.placed_at.toISOString().slice(0, 10),
          status: status.label,
          statusKey: order.status,
          detail: status.detail,
          tracking: order.status === 'shipped' || order.status === 'complete' ? order.tracking_number : null,
          summary: { items: items.map(itemView), totals: totalsView(order) },
          total: formatMoney(order.total_cents),
        },
      });
    },
  );
}
