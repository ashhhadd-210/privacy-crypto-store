/**
 * Policy pages: the public pages, and the admin editor for them.
 *
 * Text is plain, stored in the settings table, split into paragraphs on blank
 * lines and escaped like every other piece of store text: nothing the admin
 * types can become markup or script.
 */

import type { FastifyInstance } from 'fastify';

import { itemCount, readCart } from '../lib/cart.js';
import { getDb } from '../lib/db.js';
import { POLICY_PAGES, type PolicyKey, defaultPolicy } from '../lib/policy-defaults.js';
import { getSettings, invalidateSettings } from '../lib/settings.js';
import { requireAdmin } from './admin.js';

const KEYS = Object.keys(POLICY_PAGES) as PolicyKey[];
const settingKey = (k: PolicyKey) => `page_${k}`;
const MAX = 20_000;

async function pageText(k: PolicyKey): Promise<{ text: string; custom: boolean }> {
  const row = await getDb().selectFrom('settings').select('value').where('key', '=', settingKey(k)).executeTakeFirst();
  if (typeof row?.value === 'string' && row.value.trim() !== '') return { text: row.value, custom: true };
  return { text: defaultPolicy(k, (await getSettings()).retention_days), custom: false };
}

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  for (const k of KEYS) {
    app.get(POLICY_PAGES[k].path, async (request, reply) => {
      const { text } = await pageText(k);
      return reply.view('shop/page.njk', {
        title: POLICY_PAGES[k].title,
        bodyClass: 'shop',
        cartCount: itemCount(readCart(request)),
        paragraphs: text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== ''),
      });
    });
  }

  app.get<{ Querystring: { saved?: string } }>('/admin/pages', { preHandler: requireAdmin }, async (request, reply) => {
    const pages = await Promise.all(KEYS.map(async (k) => ({ key: k, ...POLICY_PAGES[k], ...(await pageText(k)) })));
    return reply.header('cache-control', 'no-store').view('admin/pages.njk', {
      title: 'Pages',
      bodyClass: 'admin',
      section: 'pages',
      csrfToken: reply.generateCsrf(),
      pages,
      saved: request.query.saved === '1',
      max: MAX,
    });
  });

  app.post('/admin/pages', { preValidation: app.csrfProtection, preHandler: requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const changed: string[] = [];
    for (const k of KEYS) {
      const v = body[k];
      if (typeof v !== 'string') continue;
      const text = v.replace(/\r\n/g, '\n').slice(0, MAX);
      const { text: current } = await pageText(k);
      if (text === current) continue;
      await db
        .insertInto('settings')
        .values({ key: settingKey(k), value: JSON.stringify(text) })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(text), updated_at: new Date() }))
        .execute();
      changed.push(k);
    }
    invalidateSettings();
    if (changed.length > 0) {
      await db
        .insertInto('audit_log')
        .values({ actor: request.adminUser?.email ?? 'unknown', action: 'pages.update', entity: 'pages', entity_id: null, metadata: JSON.stringify({ changed }) })
        .execute();
    }
    return reply.redirect('/admin/pages?saved=1', 303);
  });
}
