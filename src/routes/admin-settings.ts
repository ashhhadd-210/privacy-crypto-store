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
import { LOGO_MESSAGES } from './admin-logo.js';

type SpendRow = { over: string; pct: string };
type Values = { spend: SpendRow[]; store_name: string; currency: string; shipping: string; free_over: string; retention_days: string; complete_after_days: string; purge_enabled: boolean; export_before_purge: boolean };
type Errors = Partial<Record<'store_name' | 'shipping' | 'free_over' | 'spend' | 'retention_days' | 'complete_after_days', string>>;

const SPEND_KEYS = [
  ['spend1_over_cents', 'spend1_percent'],
  ['spend2_over_cents', 'spend2_percent'],
  ['spend3_over_cents', 'spend3_percent'],
] as const;

/**
 * Discounts by order total. Optional in the form (left out, the saved tiers
 * stand). A row is both fields or neither; larger orders get more off.
 */
function parseSpend(body: Record<string, unknown>, rows: SpendRow[]): { error?: string; data?: Partial<StoreSettings> } {
  if (body['spend_over_1'] === undefined) return {};
  const tiers: { over: number; pct: number }[] = [];
  const data: Partial<StoreSettings> = {};
  for (const [i, r] of rows.entries()) {
    const [overKey, pctKey] = SPEND_KEYS[i]!;
    if (r.over === '' && r.pct === '') { Object.assign(data, { [overKey]: 0, [pctKey]: 0 }); continue; }
    if (r.over === '' || r.pct === '') return { error: 'Fill in both the amount and the percentage on each row, or leave both empty.' };
    const over = parsePrice(r.over);
    if (over === null || over === 0) return { error: 'Enter order amounts like 500 or 1000.' };
    const pct = Number(r.pct.replace(/%$/, ''));
    if (!Number.isInteger(pct) || pct < 1 || pct > 90) return { error: 'Percentages are whole numbers from 1 to 90.' };
    tiers.push({ over, pct });
    Object.assign(data, { [overKey]: over, [pctKey]: pct });
  }
  const sorted = [...tiers].sort((a, b) => a.over - b.over);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.over === sorted[i - 1]!.over) return { error: 'Each row needs a different order amount.' };
    if (sorted[i]!.pct <= sorted[i - 1]!.pct) return { error: 'Larger orders should get a larger percentage off.' };
  }
  return { data };
}

const CURRENCIES = ['USD'];

function toValues(s: StoreSettings): Values {
  return {
    spend: SPEND_KEYS.map(([o, p]) => (s[o] > 0 && s[p] > 0 ? { over: priceInput(s[o]), pct: String(s[p]) } : { over: '', pct: '' })),
    store_name: s.store_name,
    currency: s.currency,
    shipping: priceInput(s.shipping_flat_cents),
    free_over: s.free_shipping_over_cents > 0 ? priceInput(s.free_shipping_over_cents) : '',
    retention_days: String(s.retention_days),
    complete_after_days: String(s.complete_after_days),
    purge_enabled: s.purge_enabled,
    export_before_purge: s.export_before_purge,
  };
}

function parse(body: Record<string, unknown>): { values: Values; errors: Errors; data?: Partial<StoreSettings> } {
  const str = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const values: Values = {
    spend: [1, 2, 3].map((i) => ({ over: str(`spend_over_${i}`, 12), pct: str(`spend_pct_${i}`, 4) })),
    store_name: str('store_name', 60),
    currency: CURRENCIES.includes(str('currency', 3)) ? str('currency', 3) : 'USD',
    shipping: str('shipping', 12),
    free_over: str('free_over', 12),
    retention_days: str('retention_days', 5),
    complete_after_days: str('complete_after_days', 4),
    purge_enabled: body['purge_enabled'] === 'on',
    export_before_purge: body['export_before_purge'] === 'on',
  };
  const errors: Errors = {};
  if (values.store_name.length > 60) errors.store_name = 'Keep the name to 60 characters.';
  const shipping = values.shipping === '' ? 0 : parsePrice(values.shipping);
  if (shipping === null) errors.shipping = 'Enter an amount like 5 or 5.50, or 0 for free shipping.';
  // Optional in the form: left out, the saved value stands. Empty or 0 switches it off.
  const freeOver = body['free_over'] === undefined ? undefined : values.free_over === '' ? 0 : parsePrice(values.free_over);
  if (freeOver === null) errors.free_over = 'Enter an amount like 300, or leave it empty for no free shipping.';
  const spend = parseSpend(body, values.spend);
  if (spend.error !== undefined) errors.spend = spend.error;
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
      ...(freeOver !== undefined && freeOver !== null ? { free_shipping_over_cents: freeOver } : {}),
      ...(spend.data ?? {}),
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

  app.get<{ Querystring: { saved?: string; purged?: string; logo?: string } }>('/admin/settings', guard, async (request, reply) => {
    const s = await getSettings(db);
    const code = request.query.logo;
    return render(reply, toValues(s), {}, {
      saved: request.query.saved === '1',
      purged: request.query.purged,
      hasLogo: s.logo_path !== '',
      logoMessage: code !== undefined && Object.hasOwn(LOGO_MESSAGES, code) ? LOGO_MESSAGES[code] : undefined,
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
