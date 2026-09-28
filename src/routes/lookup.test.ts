/**
 * Guest order lookup tests. Orders are written straight to the database with
 * real encryption and a real blind index, and deleted afterwards.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { blindIndex, encrypt, encryptAddress } from '../lib/crypto.js';
import { closeDb, getDb } from '../lib/db.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(3).toString('hex').toUpperCase();
const EMAIL = `lookup.${RUN.toLowerCase()}@example.com`;
const NAME = 'Lookup Probe Qwv';
const PENDING = `SO-LK${RUN.slice(0, 2)}-${RUN.slice(2, 6)}`;
const SHIPPED = `SO-LS${RUN.slice(0, 2)}-${RUN.slice(2, 6)}`;

let app: App;
let v: Visitor;

async function insertOrder(number: string, status: 'pending' | 'shipped', tracking: string | null) {
  const db = getDb();
  const order = await db
    .insertInto('orders')
    .values({
      order_number: number,
      customer_id: null,
      status,
      email_enc: encrypt(EMAIL, 'orders.email'),
      email_bidx: blindIndex(EMAIL, 'orders.email'),
      name_enc: encrypt(NAME, 'orders.name'),
      address_enc: encryptAddress({ line1: '7 Lookup Lane', city: 'Probeville', postcode: 'LK1 1QW', country: 'Probeland' }),
      phone_enc: null,
      subtotal_cents: 4800,
      discount_cents: 480,
      shipping_cents: 0,
      total_cents: 4320,
      promotion_id: null,
      checkout_token: null,
      tracking_number: tracking,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('order_items')
    .values({ order_id: order.id, product_id: null, name_snapshot: 'Lookup Probe Item', unit_price_cents: 2400, quantity: 2, line_total_cents: 4800 })
    .execute();
}

before(async () => {
  app = await buildServer();
  await app.ready();
  await insertOrder(PENDING, 'pending', null);
  await insertOrder(SHIPPED, 'shipped', 'TRACK-123-QWV');
});

after(async () => {
  await getDb().deleteFrom('orders').where('order_number', 'in', [PENDING, SHIPPED]).execute();
  await app.close();
  await closeDb();
});

beforeEach(() => {
  v = new Visitor(app, '/order');
});

const lookup = (number: string, email: string) => v.post('/order', { number, email });
/** The page minus what legitimately differs per request. */
const stable = (body: string) =>
  body.replace(/name="_csrf" value="[^"]+"/g, '').replace(/value="[^"]*"/g, '');

test('the lookup form asks for order number and email only', async () => {
  const res = await v.get('/order');
  assert.equal(res.statusCode, 200);
  const names = [...res.body.matchAll(/<input[^>]+name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['_csrf', 'email', 'number']);
  assert.match(res.body, /method="post"/);
});

test('the right number and email show the order status, items and totals', async () => {
  const res = await lookup(PENDING, EMAIL);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Awaiting payment/);
  assert.match(res.body, /Lookup Probe Item/);
  assert.match(res.body, /&minus;\$4\.80/);
  assert.match(res.body, /\$43\.20/);
});

test('number and email are forgiving about case and spaces', async () => {
  const res = await lookup(`  ${PENDING.toLowerCase()} `, `  ${EMAIL.toUpperCase()}  `);
  assert.match(res.body, /Awaiting payment/);
});

test('nothing personal is shown, even to someone with the right email', async () => {
  const res = await lookup(PENDING, EMAIL);
  for (const secret of [NAME, EMAIL, '7 Lookup Lane', 'Probeville', 'LK1 1QW']) {
    assert.ok(!res.body.includes(secret), `lookup page shows "${secret}"`);
  }
});

test('a shipped order shows its tracking number', async () => {
  const res = await lookup(SHIPPED, EMAIL);
  assert.match(res.body, /Shipped/);
  assert.match(res.body, /TRACK-123-QWV/);
});

test('a wrong email and a number that does not exist look exactly the same', async () => {
  const wrongEmail = await lookup(PENDING, 'someone.else@example.com');
  const noSuchOrder = await new Visitor(app, '/order').post('/order', { number: 'SO-ZZZZ-ZZZZ', email: EMAIL });
  assert.equal(wrongEmail.statusCode, noSuchOrder.statusCode);
  assert.match(wrongEmail.body, /could not find an order/);
  assert.equal(stable(wrongEmail.body), stable(noSuchOrder.body));
  assert.ok(!wrongEmail.body.includes('Awaiting payment'));
});

test('the email is never put in a URL: looking up by query string does nothing', async () => {
  const res = await v.get(`/order?number=${PENDING}&email=${encodeURIComponent(EMAIL)}`);
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('Awaiting payment'));
});

test('lookup pages are never cached', async () => {
  const res = await lookup(PENDING, EMAIL);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('a lookup without a CSRF token is refused', async () => {
  await v.token();
  const res = await v.post('/order', { number: PENDING, email: EMAIL }, false);
  assert.equal(res.statusCode, 403);
});

test('guessing is rate limited', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await lookup(`SO-GUES-S${i}00`, EMAIL)).statusCode);
  assert.deepEqual(statuses.slice(0, 5), Array(5).fill(200));
  assert.equal(statuses[5], 429);
});
