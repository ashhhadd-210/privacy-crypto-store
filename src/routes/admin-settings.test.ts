/**
 * Settings page tests: validation, persistence, effect on checkout and the
 * store name, and the audit trail.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { hashPassword } from '../lib/session.js';
import { getSettings, invalidateSettings, saveSettings } from '../lib/settings.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(4).toString('hex');
const EMAIL = `admin-settings-${RUN}@example.com`;
const PASSWORD = 'correct horse battery staple 6160';
const SLUG = `settings-probe-${RUN}`;

let app: App;
let admin: Visitor;
let original: Awaited<ReturnType<typeof getSettings>>;

const FORM = (over: Record<string, string> = {}) => ({
  store_name: 'Probe Goods', currency: 'USD', shipping: '0', free_over: '', retention_days: '30', purge_enabled: 'on', export_before_purge: 'on', ...over,
});

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  original = { ...(await getSettings(db)) };
  await db.insertInto('admin_users').values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null }).execute();
  await db.insertInto('products').values({ slug: SLUG, name: 'Settings Probe', price_cents: 2000, stock: 9, active: true }).execute();
});

after(async () => {
  const db = getDb();
  await saveSettings(db, original);
  invalidateSettings();
  await db.deleteFrom('products').where('slug', '=', SLUG).execute();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/settings');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: EMAIL, password: PASSWORD })).headers['location'], '/admin');
  admin.jar = login.jar;
});

test('settings need a signed-in admin and a CSRF token', async () => {
  assert.equal((await new Visitor(app, '/admin/login').get('/admin/settings')).headers['location'], '/admin/login');
  assert.equal((await admin.post('/admin/settings', FORM(), false)).statusCode, 403);
});

test('saved settings are shown back and recorded with old and new values', async () => {
  const res = await admin.post('/admin/settings', FORM({ store_name: `Probe Goods ${RUN}`, shipping: '4.50', retention_days: '45' }));
  assert.equal(res.headers['location'], '/admin/settings?saved=1');
  const page = await admin.get('/admin/settings?saved=1');
  assert.match(page.body, new RegExp(`value="Probe Goods ${RUN}"`));
  assert.match(page.body, /value="4\.50"/);
  assert.match(page.body, /value="45"/);
  const log = await getDb().selectFrom('audit_log').select('metadata').where('actor', '=', EMAIL).where('action', '=', 'settings.update').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  const meta = log.metadata as Record<string, { from: unknown; to: unknown }>;
  assert.equal(meta['retention_days']?.to, 45);
  assert.equal(meta['shipping_flat_cents']?.to, 450);
});

test('the store name reaches every page', async () => {
  await admin.post('/admin/settings', FORM({ store_name: `Lantern ${RUN}` }));
  invalidateSettings();
  const shop = await app.inject({ method: 'GET', url: '/' });
  assert.match(shop.body, new RegExp(`<title>Shop · Lantern ${RUN}</title>`));
  assert.match(shop.body, new RegExp(`alt="Lantern ${RUN}"`));
});

test('the shipping rate reaches the checkout total', async () => {
  await admin.post('/admin/settings', FORM({ shipping: '6' }));
  invalidateSettings();
  const shopper = new Visitor(app, `/p/${SLUG}`);
  await shopper.add(SLUG);
  const page = await shopper.get('/checkout');
  assert.match(page.body, /Shipping<\/span> <span>\$6\.00/);
  assert.match(page.body, /Total<\/span> <strong>\$26\.00/);
});

test('orders at or over the free-shipping amount ship free', async () => {
  // The probe product costs $20.00.
  await admin.post('/admin/settings', FORM({ shipping: '6', free_over: '20' }));
  invalidateSettings();
  const over = new Visitor(app, `/p/${SLUG}`);
  await over.add(SLUG);
  const free = await over.get('/checkout');
  assert.match(free.body, /Shipping<\/span> <span>\$0\.00/);
  assert.match(free.body, /Total<\/span> <strong>\$20\.00/);

  await admin.post('/admin/settings', FORM({ shipping: '6', free_over: '50' }));
  invalidateSettings();
  const under = new Visitor(app, `/p/${SLUG}`);
  await under.add(SLUG);
  const paid = await under.get('/checkout');
  assert.match(paid.body, /Shipping<\/span> <span>\$6\.00/);
  assert.match(paid.body, /Total<\/span> <strong>\$26\.00/);

  await admin.post('/admin/settings', FORM({ shipping: '6', free_over: 'lots' }));
  invalidateSettings();
  assert.equal((await getSettings()).free_shipping_over_cents, 5000, 'a bad amount is refused and the old one stands');
  await admin.post('/admin/settings', FORM());
  invalidateSettings();
});

test('bad values are refused and nothing changes', async () => {
  await admin.post('/admin/settings', FORM({ retention_days: '30' }));
  for (const [over, message] of [
    [{ retention_days: '0' }, /whole number of days from 1 to 3650/],
    [{ retention_days: '4000' }, /whole number of days from 1 to 3650/],
    [{ retention_days: 'abc' }, /whole number of days/],
    [{ shipping: 'free' }, /amount like 5 or 5\.50/],
  ] as const) {
    const res = await admin.post('/admin/settings', FORM(over));
    assert.equal(res.statusCode, 400, JSON.stringify(over));
    assert.match(res.body, message);
  }
  invalidateSettings();
  assert.equal((await getSettings()).retention_days, 30);
});

test('the purge can be run from the settings page', async () => {
  // Ten years, so this run cannot touch rows other test files are using.
  await admin.post('/admin/settings', FORM({ retention_days: '3650' }));
  invalidateSettings();
  const res = await admin.post('/admin/settings/purge', {});
  assert.match(String(res.headers['location']), /^\/admin\/settings\?purged=\d+$/);
  const run = await getDb().selectFrom('purge_runs').select('triggered_by').orderBy('ran_at', 'desc').limit(1).executeTakeFirstOrThrow();
  assert.equal(run.triggered_by, 'admin');
});
