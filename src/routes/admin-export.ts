/**
 * Encrypted export: every order the server still holds, with its delivery
 * details, as one JSON file locked to the client's own age public key.
 *
 * The details are decrypted in memory, encrypted again to the client's key and
 * streamed to the browser. Nothing readable is ever written to the server's
 * disk, and the server cannot open the file it produced: only the client's
 * secret key, kept offline, can. Exported orders are marked, which is what
 * "export before deleting" checks.
 */

import type { FastifyInstance } from 'fastify';

import { encrypt as ageEncrypt } from '../lib/age.js';
import { loadConfig } from '../lib/config.js';
import { decrypt, decryptAddress } from '../lib/crypto.js';
import { getDb } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';
import { requireAdmin } from './admin.js';

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export async function adminExportRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/admin/export', { preHandler: requireAdmin }, async (_request, reply) => {
    const recipient = loadConfig().EXPORT_AGE_RECIPIENT || null;
    const counts = await db
      .selectFrom('orders')
      .select((eb) => [eb.fn.countAll<number>().as('all'), eb.fn.count<number>('exported_at').as('exported')])
      .executeTakeFirstOrThrow();
    const last = await db
      .selectFrom('audit_log')
      .select(['created_at', 'actor'])
      .where('action', '=', 'export.download')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return reply.header('cache-control', 'no-store').view('admin/export.njk', {
      title: 'Export',
      bodyClass: 'admin',
      section: 'export',
      csrfToken: reply.generateCsrf(),
      recipient: recipient && `${recipient.slice(0, 10)}…${recipient.slice(-6)}`,
      total: Number(counts.all),
      notExported: Number(counts.all) - Number(counts.exported),
      last: last && { when: last.created_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC', by: last.actor },
      retentionDays: (await getSettings(db)).retention_days,
    });
  });

  app.post('/admin/export', { preValidation: app.csrfProtection, preHandler: requireAdmin }, async (request, reply) => {
    const recipient = loadConfig().EXPORT_AGE_RECIPIENT;
    if (!recipient) return reply.redirect('/admin/export', 303);

    const orders = await db.selectFrom('orders').selectAll().orderBy('placed_at').execute();
    const items = await db
      .selectFrom('order_items')
      .select(['order_id', 'name_snapshot', 'unit_price_cents', 'quantity', 'line_total_cents'])
      .execute();
    const byOrder = new Map<string, typeof items>();
    for (const i of items) byOrder.set(i.order_id, [...(byOrder.get(i.order_id) ?? []), i]);
    const accounts = await db.selectFrom('customers').select(['email_enc', 'created_at', 'last_login_at']).execute();
    const settings = await getSettings(db);

    const exportedAt = new Date();
    const document = {
      format: 'davmad-store-export/1',
      store: settings.store_name || null,
      exported_at: exportedAt.toISOString(),
      currency: settings.currency,
      amounts_are: 'integer cents',
      orders: orders.map((o) => ({
        order_number: o.order_number,
        status: o.status,
        placed_at: iso(o.placed_at),
        paid_at: iso(o.paid_at),
        shipped_at: iso(o.shipped_at),
        tracking_number: o.tracking_number,
        customer: {
          name: decrypt(o.name_enc, 'orders.name'),
          email: decrypt(o.email_enc, 'orders.email'),
          address: decryptAddress(o.address_enc),
        },
        items: (byOrder.get(o.id) ?? []).map((i) => ({ name: i.name_snapshot, unit_price: i.unit_price_cents, quantity: i.quantity, line_total: i.line_total_cents })),
        subtotal: o.subtotal_cents,
        discount: o.discount_cents,
        shipping: o.shipping_cents,
        total: o.total_cents,
        staff_note: o.admin_note,
      })),
      accounts: accounts.map((a) => ({ email: decrypt(a.email_enc, 'customers.email'), created_at: iso(a.created_at), last_sign_in: iso(a.last_login_at) })),
    };
    const locked = ageEncrypt(Buffer.from(JSON.stringify(document, null, 2)), [recipient]);

    if (orders.length > 0) {
      await db.updateTable('orders').set({ exported_at: exportedAt }).where('id', 'in', orders.map((o) => o.id)).execute();
    }
    await db
      .insertInto('audit_log')
      .values({ actor: request.adminUser?.email ?? 'unknown', action: 'export.download', entity: 'export', entity_id: null, metadata: JSON.stringify({ orders: orders.length, accounts: accounts.length }) })
      .execute();

    const stamp = exportedAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return reply
      .header('cache-control', 'no-store')
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="store-export-${stamp}.json.age"`)
      .send(locked);
  });
}
