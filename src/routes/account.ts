/**
 * Customer account pages: register, sign in, order history, delete.
 *
 * Order history shows only orders with this customer's id, in the query, so
 * there is no way to reach another customer's order by changing an id. A
 * customer's own order page shows status, items and totals, and no address:
 * being signed in proves an email and a password, and the address was typed
 * for the parcel, not for later viewing.
 *
 * Self-delete removes the account and the personal data of every finished
 * order through the same routine the retention purge uses. Orders still
 * being paid for or in the post keep their delivery details until they are
 * done, then the purge takes them; they are simply no longer linked to any
 * account.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { itemCount, readCart } from '../lib/cart.js';
import { loadConfig } from '../lib/config.js';
import {
  CUSTOMER_COOKIE,
  type Customer,
  MIN_PASSWORD,
  createCustomerSession,
  customerPasswordIs,
  destroyCustomerSession,
  registerCustomer,
  resolveCustomer,
  verifyCustomerLogin,
} from '../lib/customer-auth.js';
import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { FINAL_STATES, recordPurgeRun, wipeOrder } from '../lib/retention.js';
import { STATUS } from './lookup.js';

declare module 'fastify' {
  interface FastifyRequest {
    customer?: Customer;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const credentials = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(MIN_PASSWORD).max(200),
});

function cookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    secure: loadConfig().isProduction,
    sameSite: 'lax' as const,
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

async function requireCustomer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const customer = await resolveCustomer(request.cookies[CUSTOMER_COOKIE]);
  if (customer === null) return reply.redirect('/account/login');
  request.customer = customer;
}

const date = (d: Date) => d.toISOString().slice(0, 10);

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const loginLimit = { rateLimit: { max: 5, timeWindow: '10 minutes' } };

  function page(request: FastifyRequest, reply: FastifyReply, view: string, extra: object = {}, status = 200) {
    return reply
      .code(status)
      .header('cache-control', 'no-store')
      .view(`account/${view}.njk`, {
        bodyClass: 'shop',
        cartCount: itemCount(readCart(request)),
        csrfToken: reply.generateCsrf(),
        customer: request.customer,
        minPassword: MIN_PASSWORD,
        ...extra,
      });
  }

  // --- register ----------------------------------------------------------------

  app.get('/account/register', async (request, reply) => {
    if (await resolveCustomer(request.cookies[CUSTOMER_COOKIE])) return reply.redirect('/account');
    return page(request, reply, 'register', { title: 'Create an account' });
  });

  app.post('/account/register', { preValidation: app.csrfProtection, config: loginLimit }, async (request, reply) => {
    const parsed = credentials.safeParse(request.body ?? {});
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return page(request, reply, 'register', {
        title: 'Create an account',
        error: field === 'password' ? `Use a password of at least ${MIN_PASSWORD} characters.` : 'Please enter a valid email address.',
        email: typeof (request.body as { email?: unknown })?.email === 'string' ? (request.body as { email: string }).email.slice(0, 254) : '',
      }, 400);
    }
    // Same outcome whether or not the email already had an account.
    await registerCustomer(parsed.data.email, parsed.data.password);
    return reply.redirect('/account/login?registered=1', 303);
  });

  // --- sign in / out -------------------------------------------------------------

  app.get<{ Querystring: { registered?: string } }>('/account/login', async (request, reply) => {
    if (await resolveCustomer(request.cookies[CUSTOMER_COOKIE])) return reply.redirect('/account');
    return page(request, reply, 'login', {
      title: 'Sign in',
      notice: request.query.registered === '1' ? 'Your account is ready. Sign in with your email and password.' : undefined,
    });
  });

  app.post('/account/login', { preValidation: app.csrfProtection, config: loginLimit }, async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const result = email === '' || password === '' ? { ok: false as const, reason: 'invalid' as const } : await verifyCustomerLogin(email, password);

    if (!result.ok) {
      request.log.warn({ outcome: result.reason }, 'customer login rejected');
      return page(request, reply, 'login', {
        title: 'Sign in',
        error: result.reason === 'locked' ? 'Too many failed attempts. Try again later.' : 'Those details are not correct.',
        email: email.slice(0, 254),
      }, 401);
    }
    const { token, expiresAt } = await createCustomerSession(result.customer.id);
    return reply.setCookie(CUSTOMER_COOKIE, token, cookieOptions(expiresAt)).redirect('/account', 303);
  });

  app.post('/account/logout', { preValidation: app.csrfProtection }, async (request, reply) => {
    await destroyCustomerSession(request.cookies[CUSTOMER_COOKIE]);
    return reply.clearCookie(CUSTOMER_COOKIE, cookieOptions()).redirect('/', 303);
  });

  // --- the account and its orders -------------------------------------------------

  app.get('/account', { preHandler: requireCustomer }, async (request, reply) => {
    const me = request.customer as Customer;
    const orders = await db
      .selectFrom('orders')
      .select(['id', 'order_number', 'status', 'total_cents', 'placed_at'])
      .where('customer_id', '=', me.id)
      .orderBy('placed_at', 'desc')
      .execute();
    return page(request, reply, 'index', {
      title: 'Your account',
      orders: orders.map((o) => ({
        id: o.id,
        number: o.order_number,
        placed: date(o.placed_at),
        status: STATUS[o.status]?.label ?? o.status,
        total: formatMoney(o.total_cents),
      })),
    });
  });

  app.get<{ Params: { id: string } }>('/account/orders/:id', { preHandler: requireCustomer }, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.callNotFound();
    const me = request.customer as Customer;
    const o = await db
      .selectFrom('orders')
      .select(['id', 'order_number', 'status', 'subtotal_cents', 'discount_cents', 'shipping_cents', 'total_cents', 'tracking_number', 'placed_at'])
      .where('id', '=', request.params.id)
      .where('customer_id', '=', me.id) // in the query: another customer's order is a 404, not a 403
      .executeTakeFirst();
    if (o === undefined) return reply.callNotFound();
    const items = await db
      .selectFrom('order_items')
      .select(['name_snapshot', 'quantity', 'line_total_cents'])
      .where('order_id', '=', o.id)
      .execute();
    const status = STATUS[o.status] ?? { label: o.status, detail: '' };
    return page(request, reply, 'order', {
      title: `Order ${o.order_number}`,
      order: {
        number: o.order_number,
        placed: date(o.placed_at),
        status: status.label,
        detail: status.detail,
        tracking: o.status === 'shipped' || o.status === 'complete' ? o.tracking_number : null,
        items: items.map((i) => ({ name: i.name_snapshot, qty: i.quantity, total: formatMoney(i.line_total_cents) })),
        subtotal: formatMoney(o.subtotal_cents),
        discount: o.discount_cents > 0 ? formatMoney(o.discount_cents) : null,
        shipping: formatMoney(o.shipping_cents),
        total: formatMoney(o.total_cents),
      },
    });
  });

  // --- delete ----------------------------------------------------------------------

  app.get('/account/delete', { preHandler: requireCustomer }, async (request, reply) => {
    const me = request.customer as Customer;
    const inFlight = await db
      .selectFrom('orders')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('customer_id', '=', me.id)
      .where('status', 'not in', [...FINAL_STATES])
      .executeTakeFirstOrThrow();
    return page(request, reply, 'delete', { title: 'Delete your account', inFlight: Number(inFlight.n) });
  });

  app.post('/account/delete', { preValidation: app.csrfProtection, preHandler: requireCustomer, config: loginLimit }, async (request, reply) => {
    const me = request.customer as Customer;
    const password = (request.body as { password?: unknown })?.password;
    if (typeof password !== 'string' || !(await customerPasswordIs(me.id, password))) {
      return page(request, reply, 'delete', { title: 'Delete your account', error: 'That password is not correct.', inFlight: 0 }, 401);
    }

    await db.transaction().execute(async (trx) => {
      const finished = await trx
        .selectFrom('orders')
        .select('id')
        .where('customer_id', '=', me.id)
        .where('status', 'in', [...FINAL_STATES])
        .execute();
      let wiped = 0;
      for (const o of finished) if (await wipeOrder(trx, o.id)) wiped += 1;
      // Orders still in flight lose their link to the account (ON DELETE SET NULL)
      // and keep their own encrypted delivery copy until they are done.
      await trx.deleteFrom('customers').where('id', '=', me.id).execute();
      await recordPurgeRun(trx, {
        retention_days: 0,
        cutoff_at: new Date(),
        orders_purged: wiped,
        customers_purged: 1,
        webhooks_purged: 0,
        triggered_by: 'account-delete',
      });
    });
    request.log.info('customer account deleted');
    return reply.clearCookie(CUSTOMER_COOKIE, cookieOptions()).redirect('/account/deleted', 303);
  });

  app.get('/account/deleted', async (request, reply) => page(request, reply, 'deleted', { title: 'Account deleted' }));
}
