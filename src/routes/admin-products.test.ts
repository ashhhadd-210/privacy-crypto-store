/**
 * Admin product management tests: the form rules on their own, then the
 * whole flow through a signed-in admin session. Own admin and products,
 * deleted afterwards.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { parsePrice, priceInput, slugify } from '../lib/product-form.js';
import { hashPassword } from '../lib/session.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(4).toString('hex');
const EMAIL = `admin-products-${RUN}@example.com`;
const PASSWORD = 'correct horse battery staple 5521';
const NAME = `Admin Probe ${RUN}`;

let app: App;
let admin: Visitor;

before(async () => {
  app = await buildServer();
  await app.ready();
  await getDb()
    .insertInto('admin_users')
    .values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null })
    .execute();
});

after(async () => {
  const db = getDb();
  await db.deleteFrom('products').where('name', 'like', `Admin Probe ${RUN}%`).execute();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/products/new');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  const res = await login.post('/admin/login', { email: EMAIL, password: PASSWORD });
  assert.equal(res.headers['location'], '/admin', 'admin login');
  admin.jar = login.jar;
});

const FORM = { name: NAME, description: 'First paragraph.\n\nSecond.', price: '24.50', stock: '7', track_stock: 'on', sort_order: '5' };

async function create(fields: Record<string, string> = FORM): Promise<string> {
  const res = await admin.post('/admin/products', fields);
  assert.equal(res.statusCode, 303, `create: ${res.statusCode}`);
  const id = /\/admin\/products\/([0-9a-f-]{36})\?saved=1/.exec(String(res.headers['location']))?.[1];
  assert.ok(id);
  return id;
}

const row = (id: string) => getDb().selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

// --- the rules on their own ------------------------------------------------

test('prices are read as exact text, never through floating point', () => {
  assert.equal(parsePrice('24'), 2400);
  assert.equal(parsePrice('24.5'), 2450);
  assert.equal(parsePrice('24.50'), 2450);
  assert.equal(parsePrice('0.29'), 29); // 0.29 * 100 is 28.999999999999996 in floating point
  assert.equal(parsePrice(' $1,234.56 '), 123456);
  assert.equal(parsePrice('0'), 0);
  for (const bad of ['', '24.555', '-1', 'abc', '1e3', '24,5', '.50', '1000000', 'NaN', '24.5.0']) {
    assert.equal(parsePrice(bad), null, bad);
  }
  assert.equal(priceInput(2450), '24.50');
  assert.equal(priceInput(5), '0.05');
});

test('web addresses are made from names, safely', () => {
  assert.equal(slugify('Sample Product Two — Extended Edition!'), 'sample-product-two-extended-edition');
  assert.equal(slugify('Café Crème'), 'cafe-creme');
  assert.equal(slugify('<script>'), 'script');
  assert.equal(slugify('!!!'), '');
});

// --- access ----------------------------------------------------------------

test('product management needs a signed-in admin', async () => {
  const stranger = new Visitor(app, '/admin/login');
  for (const url of ['/admin/products', '/admin/products/new']) {
    const res = await stranger.get(url);
    assert.equal(res.statusCode, 302, url);
    assert.equal(res.headers['location'], '/admin/login', url);
  }
  const res = await stranger.post('/admin/products', FORM, false);
  assert.notEqual(res.statusCode, 303, 'a signed-out POST must not create anything');
});

test('changes need a CSRF token even when signed in', async () => {
  const res = await admin.post('/admin/products', FORM, false);
  assert.equal(res.statusCode, 403);
});

test('admin pages are never cached or indexed', async () => {
  const res = await admin.get('/admin/products');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.body, /noindex/);
});

// --- adding and editing ----------------------------------------------------

test('a new product is saved exactly, and starts hidden from the shop', async () => {
  const id = await create();
  const p = await row(id);
  assert.equal(p.name, NAME);
  assert.equal(p.price_cents, 2450);
  assert.equal(p.stock, 7);
  assert.equal(p.track_stock, true);
  assert.equal(p.active, false);
  assert.equal(p.slug, slugify(NAME));

  assert.equal((await app.inject({ method: 'GET', url: `/p/${p.slug}` })).statusCode, 404, 'hidden means not in the shop');
  assert.match((await admin.get('/admin/products')).body, new RegExp(`${NAME}[\\s\\S]*?Hidden`));
});

test('two products with the same name get different web addresses', async () => {
  const a = await row(await create({ ...FORM, name: `${NAME} Twin` }));
  const b = await row(await create({ ...FORM, name: `${NAME} Twin` }));
  assert.notEqual(a.slug, b.slug);
  assert.equal(b.slug, `${a.slug}-2`);
});

test('publishing a product puts it in the shop at the new price', async () => {
  const id = await create();
  const p = await row(id);
  const res = await admin.post(`/admin/products/${id}`, { ...FORM, price: '30', stock: '2', active: 'on', slug: p.slug });
  assert.equal(res.headers['location'], `/admin/products/${id}?saved=1`);

  const shop = await app.inject({ method: 'GET', url: `/p/${p.slug}` });
  assert.equal(shop.statusCode, 200);
  assert.match(shop.body, /\$30\.00/);
  assert.match(shop.body, /Only 2 left/);
});

test('unticking "count stock" makes a product never sell out', async () => {
  const id = await create({ ...FORM, name: `${NAME} Made To Order`, stock: '0', active: 'on', track_stock: '' });
  const p = await row(id);
  assert.equal(p.track_stock, false);
  const shop = await app.inject({ method: 'GET', url: `/p/${p.slug}` });
  assert.match(shop.body, /Add to cart/);
});

test('mistakes are explained, what was typed is kept, and nothing is saved', async () => {
  const before = await getDb().selectFrom('products').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const res = await admin.post('/admin/products', { ...FORM, name: '', price: '24.555', stock: '-3', slug: 'Not A Slug!' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Nothing was saved/);
  assert.match(res.body, /Give the product a name/);
  assert.match(res.body, /Enter a price like 24 or 24\.50/);
  assert.match(res.body, /Stock cannot be negative/);
  assert.match(res.body, /lower-case letters, numbers and single dashes/);
  assert.match(res.body, /value="24\.555"/);
  const after = await getDb().selectFrom('products').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  assert.equal(Number(after.n), Number(before.n));
});

test('product text is shown back escaped, in the admin as in the shop', async () => {
  const id = await create({ ...FORM, name: `${NAME} <img src=x onerror=alert(1)>` });
  const list = await admin.get('/admin/products');
  assert.ok(!list.body.includes('<img src=x onerror'));
  assert.match(list.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const form = await admin.get(`/admin/products/${id}`);
  assert.ok(!form.body.includes('<img src=x onerror'));
});

test('an unknown or malformed product id is a plain 404', async () => {
  assert.equal((await admin.get('/admin/products/not-a-uuid')).statusCode, 404);
  assert.equal((await admin.get('/admin/products/00000000-0000-0000-0000-000000000000')).statusCode, 404);
});

// --- the record ------------------------------------------------------------

test('every change is recorded: who, which product, which fields', async () => {
  const id = await create();
  const p = await row(id);
  await admin.post(`/admin/products/${id}`, { ...FORM, price: '99', slug: p.slug });
  // Saving again with nothing changed writes nothing.
  await admin.post(`/admin/products/${id}`, { ...FORM, price: '99', slug: p.slug });

  const log = await getDb()
    .selectFrom('audit_log')
    .select(['action', 'actor', 'metadata'])
    .where('entity_id', '=', id)
    .orderBy('created_at')
    .execute();
  assert.deepEqual(log.map((l) => l.action), ['product.create', 'product.update']);
  assert.ok(log.every((l) => l.actor === EMAIL));
  assert.deepEqual((log[1]?.metadata as { changed: string[] }).changed, ['price_cents']);
});
