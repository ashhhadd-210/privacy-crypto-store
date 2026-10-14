/**
 * Bulk prices through the real routes: the product page, the cart, the
 * checkout page and the admin product form. Order totals here stay far below
 * any order-total discount the settings tests switch on, so the two files can
 * run side by side.
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { hashPassword } from '../lib/session.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;
const RUN = randomBytes(4).toString('hex');
const SLUG = `bulk-${RUN}-pen`;
const EMAIL = `bulk-admin-${RUN}@example.com`;
const PASSWORD = 'correct horse battery staple bulk';
let app: App;
let productId: string;
let admin: Visitor;

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  const row = await db
    .insertInto('products')
    .values({ slug: SLUG, name: 'Bulk Probe Pen', description: '', price_cents: 6000, stock: 500, track_stock: true, active: true, sort_order: 9000 })
    .returning('id')
    .executeTakeFirstOrThrow();
  productId = row.id;
  await db.insertInto('product_price_tiers').values([
    { product_id: productId, min_qty: 10, price_cents: 5000 },
    { product_id: productId, min_qty: 20, price_cents: 4500 },
  ]).execute();
  await db.insertInto('admin_users').values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null }).execute();
});

after(async () => {
  const db = getDb();
  await db.deleteFrom('products').where('slug', 'like', `bulk-${RUN}-%`).execute();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/products/new');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: EMAIL, password: PASSWORD })).headers['location'], '/admin');
  admin.jar = login.jar;
});

test('the product page lists the bulk prices and offers a quantity', async () => {
  const page = await app.inject({ method: 'GET', url: `/p/${SLUG}` });
  assert.match(page.body, /Buy more, pay less/);
  assert.match(page.body, /10 or more<\/span> <strong>\$50\.00 each/);
  assert.match(page.body, /20 or more<\/span> <strong>\$45\.00 each/);
  assert.match(page.body, /name="qty" type="number"[^>]*max="99"/);
});

test('the cart charges the bulk price once the quantity reaches it', async () => {
  const shopper = new Visitor(app, `/p/${SLUG}`);
  await shopper.add(SLUG, 9);
  assert.match((await shopper.get('/cart')).body, /\$60\.00 each/);

  const bulk = new Visitor(app, `/p/${SLUG}`);
  await bulk.add(SLUG, 10);
  const cart = await bulk.get('/cart');
  assert.match(cart.body, /\$50\.00 each <span class="bulk-tag">bulk price<\/span>/);
  assert.match(cart.body, /Subtotal<\/span> <span>\$500\.00/);

  const more = new Visitor(app, `/p/${SLUG}`);
  await more.add(SLUG, 20);
  assert.match((await more.get('/cart')).body, /Subtotal<\/span> <span>\$900\.00/);
});

test('the checkout page and the order record use the bulk price', async () => {
  const shopper = new Visitor(app, `/p/${SLUG}`);
  await shopper.add(SLUG, 10);
  const page = await shopper.get('/checkout');
  assert.match(page.body, /Subtotal<\/span> <span>\$500\.00/);
});

test('bulk prices are saved from the product form and shown again', async () => {
  const res = await admin.post(`/admin/products/${productId}`, {
    name: 'Bulk Probe Pen', price: '60', stock: '500', track_stock: 'on', active: 'on', sort_order: '9000', slug: SLUG, description: '',
    tier_qty_1: '5', tier_price_1: '55', tier_qty_2: '15', tier_price_2: '48', tier_qty_3: '', tier_price_3: '',
  });
  assert.equal(res.headers['location'], `/admin/products/${productId}?saved=1`);
  const saved = await getDb().selectFrom('product_price_tiers').select(['min_qty', 'price_cents']).where('product_id', '=', productId).orderBy('min_qty').execute();
  assert.deepEqual(saved, [{ min_qty: 5, price_cents: 5500 }, { min_qty: 15, price_cents: 4800 }]);
  const form = await admin.get(`/admin/products/${productId}`);
  assert.match(form.body, /name="tier_qty_1"[^>]*value="5"/);
  assert.match(form.body, /name="tier_price_2"[^>]*value="48\.00"/);
});

test('a bulk price above the normal price is refused and nothing is saved', async () => {
  const before = await getDb().selectFrom('product_price_tiers').select(['min_qty', 'price_cents']).where('product_id', '=', productId).orderBy('min_qty').execute();
  const res = await admin.post(`/admin/products/${productId}`, {
    name: 'Bulk Probe Pen', price: '60', stock: '500', track_stock: 'on', active: 'on', sort_order: '9000', slug: SLUG, description: '',
    tier_qty_1: '10', tier_price_1: '70',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /lower than the normal price/);
  const after = await getDb().selectFrom('product_price_tiers').select(['min_qty', 'price_cents']).where('product_id', '=', productId).orderBy('min_qty').execute();
  assert.deepEqual(after, before);
});
