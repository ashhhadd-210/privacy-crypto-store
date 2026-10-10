/**
 * Admin orders tests. Orders are written straight to the database with real
 * encryption, and deleted afterwards.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { blindIndex, encrypt, encryptAddress } from '../lib/crypto.js';
import { closeDb, getDb } from '../lib/db.js';
import { hashPassword } from '../lib/session.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(3).toString('hex').toUpperCase();
const EMAIL = `admin-orders-${RUN.toLowerCase()}@example.com`;
const PASSWORD = 'correct horse battery staple 3390';
const CUSTOMER = { name: `Order Probe ${RUN}`, email: `buyer.${RUN.toLowerCase()}@example.com`, line1: '9 Probe Road', city: 'Ordertown', postcode: 'OR1 9PB', country: 'Probeland' };

let app: App;
let admin: Visitor;
const numbers: string[] = [];

async function order(status: 'pending' | 'paid' | 'shipped'): Promise<string> {
  const number = `SO-T${RUN.slice(0, 3)}-${String(numbers.length).padStart(4, '0')}`;
  numbers.push(number);
  const row = await getDb()
    .insertInto('orders')
    .values({
      order_number: number, customer_id: null, status,
      email_enc: encrypt(CUSTOMER.email, 'orders.email'), email_bidx: blindIndex(CUSTOMER.email, 'orders.email'),
      name_enc: encrypt(CUSTOMER.name, 'orders.name'),
      address_enc: encryptAddress({ line1: CUSTOMER.line1, city: CUSTOMER.city, postcode: CUSTOMER.postcode, country: CUSTOMER.country }),
      phone_enc: null, subtotal_cents: 2400, total_cents: 2400, promotion_id: null, checkout_token: null,
      tracking_number: null, admin_note: null, paid_at: status === 'pending' ? null : new Date(), shipped_at: null, completed_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await getDb()
    .insertInto('order_items')
    .values({ order_id: row.id, product_id: null, name_snapshot: 'Order Probe Item', unit_price_cents: 1200, quantity: 2, line_total_cents: 2400 })
    .execute();
  return row.id;
}

const statusOf = async (id: string) =>
  (await getDb().selectFrom('orders').select(['status', 'tracking_number', 'admin_note']).where('id', '=', id).executeTakeFirstOrThrow());

before(async () => {
  app = await buildServer();
  await app.ready();
  await getDb().insertInto('admin_users').values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null }).execute();
});

after(async () => {
  const db = getDb();
  if (numbers.length > 0) await db.deleteFrom('orders').where('order_number', 'in', numbers).execute();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/orders');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: EMAIL, password: PASSWORD })).headers['location'], '/admin');
  admin.jar = login.jar;
});

test('orders need a signed-in admin', async () => {
  const res = await new Visitor(app, '/admin/login').get('/admin/orders');
  assert.equal(res.headers['location'], '/admin/login');
});

test('the order list shows no personal details', async () => {
  await order('paid');
  const res = await admin.get('/admin/orders');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, new RegExp(numbers.at(-1) as string));
  for (const secret of [CUSTOMER.name, CUSTOMER.email, CUSTOMER.line1, CUSTOMER.postcode]) {
    assert.ok(!res.body.includes(secret), `list shows "${secret}"`);
  }
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('opening an order shows the delivery details, and the opening is recorded', async () => {
  const id = await order('paid');
  const res = await admin.get(`/admin/orders/${id}`);
  assert.match(res.body, new RegExp(CUSTOMER.name));
  assert.match(res.body, /9 Probe Road/);
  assert.match(res.body, /OR1 9PB/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const views = await getDb().selectFrom('audit_log').select('actor').where('action', '=', 'order.view').where('entity_id', '=', id).execute();
  assert.deepEqual(views.map((v) => v.actor), [EMAIL]);
});

test('a paid order can be shipped with a tracking number', async () => {
  const id = await order('paid');
  const res = await admin.post(`/admin/orders/${id}/ship`, { tracking: 'TRK 1234-AB' });
  assert.equal(res.headers['location'], `/admin/orders/${id}?msg=shipped`);
  const o = await statusOf(id);
  assert.equal(o.status, 'shipped');
  assert.equal(o.tracking_number, 'TRK 1234-AB');
});

test('an unpaid order cannot be shipped', async () => {
  const id = await order('pending');
  const res = await admin.post(`/admin/orders/${id}/ship`, { tracking: 'TRK 1234' });
  assert.equal(res.headers['location'], `/admin/orders/${id}?msg=conflict`);
  assert.equal((await statusOf(id)).status, 'pending');
});

test('a bad tracking number is refused', async () => {
  const id = await order('paid');
  for (const tracking of ['', 'ab', '<script>', 'x'.repeat(61)]) {
    const res = await admin.post(`/admin/orders/${id}/ship`, { tracking });
    assert.equal(res.headers['location'], `/admin/orders/${id}?msg=tracking`, JSON.stringify(tracking));
  }
  assert.equal((await statusOf(id)).status, 'paid');
});

test('only an unpaid order can be cancelled', async () => {
  const pending = await order('pending');
  assert.equal((await admin.post(`/admin/orders/${pending}/cancel`, {})).headers['location'], `/admin/orders/${pending}?msg=cancelled`);
  assert.equal((await statusOf(pending)).status, 'cancelled');

  const paid = await order('paid');
  assert.equal((await admin.post(`/admin/orders/${paid}/cancel`, {})).headers['location'], `/admin/orders/${paid}?msg=conflict`);
  assert.equal((await statusOf(paid)).status, 'paid');
});

test('a shipped order can be marked delivered, and only a shipped one', async () => {
  const shipped = await order('shipped');
  const page = await admin.get(`/admin/orders/${shipped}`);
  assert.match(page.body, /Mark as delivered/);
  assert.equal((await admin.post(`/admin/orders/${shipped}/complete`, {})).headers['location'], `/admin/orders/${shipped}?msg=completed`);
  const done = await getDb().selectFrom('orders').select(['status', 'completed_at']).where('id', '=', shipped).executeTakeFirstOrThrow();
  assert.equal(done.status, 'complete');
  assert.ok(done.completed_at !== null);
  assert.doesNotMatch((await admin.get(`/admin/orders/${shipped}`)).body, /Mark as delivered/);

  const paid = await order('paid');
  assert.equal((await admin.post(`/admin/orders/${paid}/complete`, {})).headers['location'], `/admin/orders/${paid}?msg=conflict`);
  assert.equal((await statusOf(paid)).status, 'paid');
});

test('a shipped order can be marked refunded (a return)', async () => {
  const id = await order('shipped');
  assert.equal((await admin.post(`/admin/orders/${id}/refunded`, {})).headers['location'], `/admin/orders/${id}?msg=refunded`);
  assert.equal((await statusOf(id)).status, 'refunded');
});

test('a staff note is saved, and clearing it removes it', async () => {
  const id = await order('paid');
  await admin.post(`/admin/orders/${id}/note`, { note: 'Gift wrap requested.' });
  assert.equal((await statusOf(id)).admin_note, 'Gift wrap requested.');
  await admin.post(`/admin/orders/${id}/note`, { note: '   ' });
  assert.equal((await statusOf(id)).admin_note, null);
});

test('status changes need a CSRF token', async () => {
  const id = await order('paid');
  const res = await admin.post(`/admin/orders/${id}/ship`, { tracking: 'TRK 1234' }, false);
  assert.equal(res.statusCode, 403);
  assert.equal((await statusOf(id)).status, 'paid');
});

test('an unknown order id is a plain 404', async () => {
  assert.equal((await admin.get('/admin/orders/not-a-uuid')).statusCode, 404);
  assert.equal((await admin.get('/admin/orders/00000000-0000-0000-0000-000000000000')).statusCode, 404);
});
