/**
 * Admin orders: list, open, ship, cancel, note.
 *
 * The list shows no personal details at all. They are decrypted only when one
 * order is opened, because that is when someone needs an address to post a
 * parcel, and each opening is written to the audit log: the store can always
 * say who looked at whose details, and when.
 *
 * Status changes are guarded in the UPDATE itself (`WHERE status = ...`), so
 * two people clicking at once cannot ship a cancelled order or cancel a
 * shipped one. Ship is only offered for paid orders; cancel only for unpaid
 * ones, because cancelling a paid order means a manual Bitcoin refund (open
 * question 15) and should not be one click away.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { decrypt, decryptAddress } from '../lib/crypto.js';
import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { requireAdmin } from './admin.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid: to ship',
  shipped: 'Shipped',
  complete: 'Complete',
  expired: 'Expired unpaid',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};
const FILTERS = ['all', 'paid', 'pending', 'shipped', 'cancelled'] as const;

const MESSAGES: Record<string, { text: string; error?: true }> = {
  shipped: { text: 'Marked as shipped.' },
  cancelled: { text: 'Order cancelled.' },
  noted: { text: 'Note saved.' },
  tracking: { text: 'Enter a tracking number: letters, numbers, spaces and dashes, 3 to 60 characters.', error: true },
  conflict: { text: 'That order changed while you were looking at it. Here is how it stands now.', error: true },
};

const shipBody = z.object({ tracking: z.string().trim().regex(/^[A-Za-z0-9 -]{3,60}$/) });
const noteBody = z.object({ note: z.string().max(1000) });

const date = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC');

export async function adminOrderRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const guard = { preHandler: requireAdmin };
  const guardPost = { preValidation: app.csrfProtection, preHandler: requireAdmin };

  async function audit(actor: string | undefined, action: string, orderId: string, metadata: object = {}) {
    await db
      .insertInto('audit_log')
      .values({ actor: actor ?? 'unknown', action, entity: 'order', entity_id: orderId, metadata: JSON.stringify(metadata) })
      .execute();
  }

  app.get<{ Querystring: { status?: string } }>('/admin/orders', guard, async (request, reply) => {
    const filter = (FILTERS as readonly string[]).includes(request.query.status ?? '') ? (request.query.status as string) : 'all';
    const rows = await db
      .selectFrom('orders')
      .leftJoin('order_items', 'order_items.order_id', 'orders.id')
      .select((eb) => [
        'orders.id', 'orders.order_number', 'orders.status', 'orders.total_cents', 'orders.placed_at',
        eb.fn.coalesce(eb.fn.sum<number>('order_items.quantity'), eb.lit(0)).as('items'),
      ])
      .$if(filter !== 'all', (q) => q.where('orders.status', '=', filter as 'paid'))
      .groupBy('orders.id')
      .orderBy('orders.placed_at', 'desc')
      .limit(200)
      .execute();

    const counts = await db
      .selectFrom('orders')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .groupBy('status')
      .execute();
    const count = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));

    return reply.header('cache-control', 'no-store').view('admin/orders.njk', {
      title: 'Orders',
      bodyClass: 'admin',
      section: 'orders',
      csrfToken: reply.generateCsrf(),
      filter,
      filters: FILTERS.map((f) => ({
        key: f,
        label: f === 'all' ? 'All' : (STATUS_LABEL[f] ?? f),
        count: f === 'all' ? Object.values(count).reduce((a, b) => a + b, 0) : (count[f] ?? 0),
      })),
      orders: rows.map((o) => ({
        id: o.id,
        number: o.order_number,
        placed: date(o.placed_at),
        status: o.status,
        statusLabel: STATUS_LABEL[o.status] ?? o.status,
        items: Number(o.items),
        total: formatMoney(o.total_cents),
      })),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { msg?: string } }>('/admin/orders/:id', guard, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.callNotFound();
    const o = await db.selectFrom('orders').selectAll().where('id', '=', request.params.id).executeTakeFirst();
    if (o === undefined) return reply.callNotFound();
    const items = await db
      .selectFrom('order_items')
      .select(['name_snapshot', 'quantity', 'unit_price_cents', 'line_total_cents'])
      .where('order_id', '=', o.id)
      .execute();

    await audit(request.adminUser?.email, 'order.view', o.id);

    const msg = request.query.msg;
    return reply.header('cache-control', 'no-store').view('admin/order.njk', {
      title: `Order ${o.order_number}`,
      bodyClass: 'admin',
      section: 'orders',
      csrfToken: reply.generateCsrf(),
      message: msg !== undefined && Object.hasOwn(MESSAGES, msg) ? MESSAGES[msg] : undefined,
      order: {
        id: o.id,
        number: o.order_number,
        status: o.status,
        statusLabel: STATUS_LABEL[o.status] ?? o.status,
        placed: date(o.placed_at),
        paid: date(o.paid_at),
        shipped: date(o.shipped_at),
        tracking: o.tracking_number,
        note: o.admin_note ?? '',
        name: decrypt(o.name_enc, 'orders.name'),
        email: decrypt(o.email_enc, 'orders.email'),
        address: decryptAddress(o.address_enc),
        items: items.map((i) => ({
          name: i.name_snapshot,
          qty: i.quantity,
          unit: formatMoney(i.unit_price_cents),
          total: formatMoney(i.line_total_cents),
        })),
        subtotal: formatMoney(o.subtotal_cents),
        discount: o.discount_cents > 0 ? formatMoney(o.discount_cents) : null,
        shipping: formatMoney(o.shipping_cents),
        total: formatMoney(o.total_cents),
        canShip: o.status === 'paid',
        canCancel: o.status === 'pending',
      },
    });
  });

  const back = (id: string, msg: string) => `/admin/orders/${id}?msg=${msg}`;

  app.post<{ Params: { id: string } }>('/admin/orders/:id/ship', guardPost, async (request, reply) => {
    const { id } = request.params;
    if (!UUID.test(id)) return reply.callNotFound();
    const parsed = shipBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.redirect(back(id, 'tracking'), 303);

    const now = new Date();
    const res = await db
      .updateTable('orders')
      .set({ status: 'shipped', tracking_number: parsed.data.tracking, shipped_at: now, updated_at: now })
      .where('id', '=', id)
      .where('status', '=', 'paid')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return reply.redirect(back(id, 'conflict'), 303);
    await audit(request.adminUser?.email, 'order.ship', id);
    return reply.redirect(back(id, 'shipped'), 303);
  });

  app.post<{ Params: { id: string } }>('/admin/orders/:id/cancel', guardPost, async (request, reply) => {
    const { id } = request.params;
    if (!UUID.test(id)) return reply.callNotFound();
    const res = await db
      .updateTable('orders')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return reply.redirect(back(id, 'conflict'), 303);
    await audit(request.adminUser?.email, 'order.cancel', id);
    return reply.redirect(back(id, 'cancelled'), 303);
  });

  app.post<{ Params: { id: string } }>('/admin/orders/:id/note', guardPost, async (request, reply) => {
    const { id } = request.params;
    if (!UUID.test(id)) return reply.callNotFound();
    const parsed = noteBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.redirect(back(id, 'noted'), 303);
    const note = parsed.data.note.trim();
    const res = await db
      .updateTable('orders')
      .set({ admin_note: note === '' ? null : note, updated_at: new Date() })
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return reply.callNotFound();
    await audit(request.adminUser?.email, 'order.note', id);
    return reply.redirect(back(id, 'noted'), 303);
  });
}
