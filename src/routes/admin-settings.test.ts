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

// --- discounts by order total (14 Oct) -----------------------------------------
// Thresholds far above any other test file's cart, so files running in
// parallel never see them.

const BIG = `settings-big-${RUN}`;
const SPEND_ON = { spend_over_1: '5000', spend_pct_1: '10', spend_over_2: '8000', spend_pct_2: '20', spend_over_3: '', spend_pct_3: '' };
const SPEND_OFF = { spend_over_1: '', spend_pct_1: '', spend_over_2: '', spend_pct_2: '', spend_over_3: '', spend_pct_3: '' };

test('orders over an amount get the percentage off, and a code still applies on top', async () => {
  const db = getDb();
  await db.insertInto('products').values({ slug: BIG, name: 'Settings Big Probe', price_cents: 60_000, stock: 50, active: true }).execute();
  const code = `SPEND10-${RUN}`.toUpperCase();
  await db.insertInto('promotions').values({ code, type: 'percent', value: 10 }).execute();
  try {
    assert.equal((await admin.post('/admin/settings', FORM(SPEND_ON))).headers['location'], '/admin/settings?saved=1');
    invalidateSettings();
    const s = await getSettings();
    assert.deepEqual([s.spend1_over_cents, s.spend1_percent, s.spend2_over_cents, s.spend2_percent], [500_000, 10, 800_000, 20]);

    const shopper = new Visitor(app, `/p/${BIG}`);
    await shopper.add(BIG, 9); // $5,400
    let cart = (await shopper.get('/cart')).body;
    assert.match(cart, /Order discount <span class="muted-inline">10% off<\/span><\/span> <span>&minus;\$540\.00/);
    assert.match(cart, /Spend \$2,600\.00 more for 20% off your order\./);
    assert.match(cart, /Total<\/span> <strong>\$4,860\.00/);

    await shopper.post('/cart/promo', { code });
    cart = (await shopper.get('/cart')).body;
    // The code takes 10% of what is left after the order discount: $486.
    assert.match(cart, /&minus;\$486\.00/);
    assert.match(cart, /Total<\/span> <strong>\$4,374\.00/);

    const checkout = (await shopper.get('/checkout')).body;
    assert.match(checkout, /Order discount \(10%\)<\/span> <span>&minus;\$540\.00/);

    const bigger = new Visitor(app, `/p/${BIG}`);
    await bigger.add(BIG, 14); // $8,400: the 20% tier, not 10% + 20%
    assert.match((await bigger.get('/cart')).body, /20% off<\/span><\/span> <span>&minus;\$1,680\.00/);
  } finally {
    await admin.post('/admin/settings', FORM(SPEND_OFF));
    invalidateSettings();
    await db.deleteFrom('products').where('slug', '=', BIG).execute();
    await db.deleteFrom('promotions').where('code', '=', code).execute();
  }
  assert.equal((await getSettings()).spend1_percent, 0, 'empty rows switch the discount off');
});

test('order-total discounts that make no sense are refused', async () => {
  const before = await getSettings();
  for (const [rows, message] of [
    [{ ...SPEND_OFF, spend_over_1: '5000' }, /both the amount and the percentage/],
    [{ ...SPEND_OFF, spend_over_1: '5000', spend_pct_1: '95' }, /from 1 to 90/],
    [{ ...SPEND_OFF, spend_over_1: '5000', spend_pct_1: '20', spend_over_2: '8000', spend_pct_2: '10' }, /larger percentage off/],
    [{ ...SPEND_OFF, spend_over_1: '5000', spend_pct_1: '10', spend_over_2: '5000', spend_pct_2: '20' }, /different order amount/],
  ] as const) {
    const res = await admin.post('/admin/settings', FORM(rows));
    assert.equal(res.statusCode, 400);
    assert.match(res.body, message);
  }
  invalidateSettings();
  assert.equal((await getSettings()).spend1_over_cents, before.spend1_over_cents);
});
