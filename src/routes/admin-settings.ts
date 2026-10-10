/**
 * Admin settings page, and the "run the purge now" button.
 *
 * The retention window is the setting that matters most: it decides how long
 * customers' details exist. It is bounded (1 day to 10 years) and every change
 * is audited with the old and new value, so the client can always show when
 * their policy changed and to what.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { parsePrice, priceInput } from '../lib/product-form.js';
import { runPurge } from '../lib/retention.js';
import { type StoreSettings, getSettings, saveSettings } from '../lib/settings.js';
import { requireAdmin } from './admin.js';

type Values = { store_name: string; currency: string; shipping: string; retention_days: string; complete_after_days: string; purge_enabled: boolean; export_before_purge: boolean };
type Errors = Partial<Record<'store_name' | 'shipping' | 'retention_days' | 'complete_after_days', string>>;

const CURRENCIES = ['USD'];

function toValues(s: StoreSettings): Values {
  return {
    store_name: s.store_name,
    currency: s.currency,
    shipping: priceInput(s.shipping_flat_cents),
    retention_days: String(s.retention_days),
    complete_after_days: String(s.complete_after_days),
    purge_enabled: s.purge_enabled,
    export_before_purge: s.export_before_purge,
  };
}

function parse(body: Record<string, unknown>): { values: Values; errors: Errors; data?: Partial<StoreSettings> } {
  const str = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const values: Values = {
    store_name: str('store_name', 60),
    currency: CURRENCIES.includes(str('currency', 3)) ? str('currency', 3) : 'USD',
    shipping: str('shipping', 12),
    retention_days: str('retention_days', 5),
    complete_after_days: str('complete_after_days', 4),
    purge_enabled: body['purge_enabled'] === 'on',
    export_before_purge: body['export_before_purge'] === 'on',
  };
  const errors: Errors = {};
  if (values.store_name.length > 60) errors.store_name = 'Keep the name to 60 characters.';
  const shipping = values.shipping === '' ? 0 : parsePrice(values.shipping);
  if (shipping === null) errors.shipping = 'Enter an amount like 5 or 5.50, or 0 for free shipping.';
  const retention = Number(values.retention_days);
  if (!Number.isInteger(retention) || retention < 1 || retention > 3650) errors.retention_days = 'Enter a whole number of days from 1 to 3650.';
  // Optional in the form: left out, the saved value stands.
  const completeAfter = values.complete_after_days === '' ? undefined : Number(values.complete_after_days);
  if (completeAfter !== undefined && (!Number.isInteger(completeAfter) || completeAfter < 1 || completeAfter > 365)) {
    errors.complete_after_days = 'Enter a whole number of days from 1 to 365.';
  }
  if (Object.keys(errors).length > 0) return { values, errors };
  return {
    values,
    errors,
    data: {
      store_name: values.store_name,
      currency: values.currency,
      shipping_flat_cents: shipping as number,
      retention_days: retention,
      ...(completeAfter !== undefined ? { complete_after_days: completeAfter } : {}),
      purge_enabled: values.purge_enabled,
      export_before_purge: values.export_before_purge,
    },
  };
}

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const guard = { preHandler: requireAdmin };
  const guardPost = { preValidation: app.csrfProtection, preHandler: requireAdmin };

  async function render(reply: FastifyReply, values: Values, errors: Errors = {}, extra: object = {}) {
    const lastRun = await db.selectFrom('purge_runs').selectAll().orderBy('ran_at', 'desc').limit(1).executeTakeFirst();
    return reply
      .code(Object.keys(errors).length > 0 ? 400 : 200)
      .header('cache-control', 'no-store')
      .view('admin/settings.njk', {
        title: 'Settings',
        bodyClass: 'admin',
        section: 'settings',
        csrfToken: reply.generateCsrf(),
        values,
        errors,
        hasErrors: Object.keys(errors).length > 0,
        currencies: CURRENCIES,
        lastRun: lastRun && {
          when: lastRun.ran_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          orders: lastRun.orders_purged,
          customers: lastRun.customers_purged,
          by: lastRun.triggered_by,
          error: lastRun.error,
        },
        ...extra,
      });
  }

  app.get<{ Querystring: { saved?: string; purged?: string } }>('/admin/settings', guard, async (request, reply) => {
    const s = await getSettings(db);
    return render(reply, toValues(s), {}, {
      saved: request.query.saved === '1',
      purged: request.query.purged,
    });
  });

  app.post('/admin/settings', guardPost, async (request, reply) => {
    const { values, errors, data } = parse((request.body ?? {}) as Record<string, unknown>);
    if (data === undefined) return render(reply, values, errors);
    const before = await getSettings(db);
    const changed = await saveSettings(db, data);
    if (changed.length > 0) {
      await db
        .insertInto('audit_log')
        .values({
          actor: request.adminUser?.email ?? 'unknown',
          action: 'settings.update',
          entity: 'settings',
          entity_id: null,
          metadata: JSON.stringify(Object.fromEntries(changed.map((k) => [k, { from: before[k], to: data[k] }]))),
        })
        .execute();
    }
    return reply.redirect('/admin/settings?saved=1', 303);
  });

  app.post('/admin/settings/purge', guardPost, async (request, reply) => {
    const run = await runPurge(db, 'admin');
    await db
      .insertInto('audit_log')
      .values({ actor: request.adminUser?.email ?? 'unknown', action: 'purge.run', entity: 'purge', entity_id: null, metadata: JSON.stringify({ orders: run.orders_purged, customers: run.customers_purged }) })
      .execute();
    return reply.redirect(`/admin/settings?purged=${run.orders_purged}`, 303);
  });
}

export { formatMoney };
