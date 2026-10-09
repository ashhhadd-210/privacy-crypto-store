/**
 * Payment routes.
 *
 * POST /webhooks/btcpay   BTCPay's signed notification. The signature is over
 *                         the raw bytes, so this route (and only this route)
 *                         keeps the body as a Buffer. Every delivery is stored
 *                         by BTCPay's delivery id first: a repeat finds the row
 *                         and is acknowledged without doing anything twice.
 *
 * POST /checkout/pay      "Pay now" from the order-received page (signed cookie)
 * POST /order/pay         "Pay now" from guest lookup (order number + email)
 * POST /account/orders/:id/pay   from a signed-in customer's own order
 *
 * All three go through ensureInvoice, which reuses a live invoice rather than
 * billing twice, and send the customer to BTCPay's payment page.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { BtcpayUnavailable, verifyWebhook } from '../lib/btcpay.js';
import { blindIndex } from '../lib/crypto.js';
import { CUSTOMER_COOKIE, resolveCustomer } from '../lib/customer-auth.js';
import { getDb } from '../lib/db.js';
import { applyPaymentEvent, ensureInvoice, eventFromWebhook } from '../lib/payments.js';
import { ORDER_COOKIE } from './checkout.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const webhookBody = z.object({
  deliveryId: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  invoiceId: z.string().min(1).max(200),
  overPaid: z.boolean().optional(),
  partiallyPaid: z.boolean().optional(),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // --- the webhook, in its own scope so the raw-body parser applies to it alone ---
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));

    scope.post('/webhooks/btcpay', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
      const raw = request.body;
      if (!Buffer.isBuffer(raw) || !verifyWebhook(raw, request.headers['btcpay-sig'] as string | undefined)) {
        request.log.warn('payment webhook rejected: bad or missing signature');
        return reply.code(401).send({ error: 'invalid signature' });
      }
      let parsed: z.infer<typeof webhookBody>;
      try {
        parsed = webhookBody.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return reply.code(400).send({ error: 'invalid payload' });
      }

      const stored = await db
        .insertInto('payment_webhooks')
        .values({ invoice_id: parsed.invoiceId, event_type: parsed.type, delivery_id: parsed.deliveryId, payload: JSON.stringify(parsed), processed_at: null })
        .onConflict((oc) => oc.column('delivery_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (stored === undefined) return reply.send({ ok: true, outcome: 'duplicate' });

      const type = eventFromWebhook(parsed.type);
      const outcome =
        type === null
          ? 'ignored'
          : await applyPaymentEvent(db, {
              invoiceId: parsed.invoiceId,
              type,
              ...(parsed.overPaid !== undefined ? { overPaid: parsed.overPaid } : {}),
              ...(parsed.partiallyPaid !== undefined ? { partiallyPaid: parsed.partiallyPaid } : {}),
            });
      await db.updateTable('payment_webhooks').set({ processed_at: new Date() }).where('id', '=', stored.id).execute();
      request.log.info({ outcome, event: parsed.type }, 'payment webhook processed');
      return reply.send({ ok: true, outcome });
    });
  });

  // --- pay now ---------------------------------------------------------------------
  async function payOrFallback(reply: FastifyReply, orderId: string, returnPath: string, fallback: string) {
    try {
      const url = await ensureInvoice(db, orderId, returnPath);
      return reply.redirect(url ?? fallback, 303);
    } catch (err) {
      if (err instanceof BtcpayUnavailable) {
        reply.log.warn({ reason: err.message }, 'invoice could not be created');
        return reply.redirect(`${fallback}${fallback.includes('?') ? '&' : '?'}pay=unavailable`, 303);
      }
      throw err;
    }
  }

  app.post('/checkout/pay', { preValidation: app.csrfProtection }, async (request, reply) => {
    const raw = request.cookies[ORDER_COOKIE];
    const unsigned = raw === undefined ? null : request.unsignCookie(raw);
    if (unsigned === null || !unsigned.valid || !unsigned.value) return reply.redirect('/', 303);
    return payOrFallback(reply, unsigned.value, '/checkout/done', '/checkout/done');
  });

  const lookupBody = z.object({ number: z.string().trim().min(1).max(20), email: z.string().trim().min(3).max(254) });
  app.post('/order/pay', { preValidation: app.csrfProtection, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = lookupBody.safeParse(request.body ?? {});
    if (!p.success) return reply.redirect('/order', 303);
    const order = await db
      .selectFrom('orders')
      .select('id')
      .where('order_number', '=', p.data.number.toUpperCase())
      .where('email_bidx', '=', blindIndex(p.data.email, 'orders.email'))
      .executeTakeFirst();
    if (order === undefined) return reply.redirect('/order', 303);
    return payOrFallback(reply, order.id, '/order', '/order');
  });

  app.post<{ Params: { id: string } }>('/account/orders/:id/pay', { preValidation: app.csrfProtection }, async (request, reply) => {
    const customer = await resolveCustomer(request.cookies[CUSTOMER_COOKIE]);
    if (customer === null) return reply.redirect('/account/login', 303);
    if (!UUID.test(request.params.id)) return reply.callNotFound();
    const order = await db
      .selectFrom('orders')
      .select('id')
      .where('id', '=', request.params.id)
      .where('customer_id', '=', customer.id)
      .executeTakeFirst();
    if (order === undefined) return reply.callNotFound();
    const back = `/account/orders/${order.id}`;
    return payOrFallback(reply, order.id, back, back);
  });
}
