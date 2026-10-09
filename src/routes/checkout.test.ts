/**
 * Guest checkout tests, through the real plugin chain and a real database.
 * Own products and codes, deleted afterwards, because other test files read
 * the seeded catalogue in parallel.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildServer } from '../server.js';
import { CART_COOKIE, PROMO_COOKIE } from '../lib/cart.js';
import { blindIndex, decrypt, decryptAddress } from '../lib/crypto.js';
import { closeDb, getDb } from '../lib/db.js';
import { Visitor } from '../test/visitor.js';
import { ORDER_COOKIE } from './checkout.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(4).toString('hex');
const P = {
  mug: { slug: `co-${RUN}-mug`, name: 'Checkout Probe Mug', price_cents: 2400, stock: 10, track_stock: true },
  last: { slug: `co-${RUN}-last`, name: 'Checkout Probe Last', price_cents: 1250, stock: 1, track_stock: true },
};
const CODE = `CO10-${RUN}`.toUpperCase();

const CUSTOMER = {
  name: 'Probe Customer Zqx',
  email: `probe.zqx.${RUN}@example.com`,
  line1: '12 Probe Street',
  line2: 'Flat 3',
  city: 'Probetown',
  region: 'PR',
  postcode: 'ZQ9 8XY',
  country: 'Probeland',
};

let app: App;
const ids: Record<keyof typeof P, string> = {} as never;
let v: Visitor;

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  for (const [key, p] of Object.entries(P) as [keyof typeof P, (typeof P)[keyof typeof P]][]) {
    const row = await db
      .insertInto('products')
      .values({ ...p, description: '', active: true, sort_order: 9100 })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[key] = row.id;
  }
  await db.insertInto('promotions').values({ code: CODE, type: 'percent', value: 10 }).execute();
});

after(async () => {
  const db = getDb();
  const orderIds = await db
    .selectFrom('order_items')
    .select('order_id')
    .where('product_id', 'in', Object.values(ids))
    .execute();
  if (orderIds.length > 0) {
    await db.deleteFrom('orders').where('id', 'in', orderIds.map((o) => o.order_id)).execute();
  }
  await db.deleteFrom('products').where('slug', 'like', `co-${RUN}-%`).execute();
  await db.deleteFrom('promotions').where('code', '=', CODE).execute();
  await app.close();
  await closeDb();
});

beforeEach(() => {
  v = new Visitor(app, `/p/${P.mug.slug}`);
});

/** Opens the checkout page and returns its CSRF and checkout tokens. */
async function openCheckout(): Promise<{ csrf: string; token: string; expectedTotal: string; body: string }> {
  const page = await v.get('/checkout');
  assert.equal(page.statusCode, 200, `checkout page: ${page.statusCode}`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
  const token = /name="token" value="([^"]+)"/.exec(page.body)?.[1];
  const expectedTotal = /name="expectedTotal" value="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(csrf && token && expectedTotal);
  return { csrf, token, expectedTotal, body: page.body };
}

async function placeOrder(fields: Record<string, string> = CUSTOMER) {
  const { csrf, token, expectedTotal } = await openCheckout();
  return { res: await v.post('/checkout', { ...fields, _csrf: csrf, token, expectedTotal }), token };
}

async function ordersFor(token: string) {
  return getDb().selectFrom('orders').selectAll().where('checkout_token', '=', token).execute();
}

// --- the form --------------------------------------------------------------

test('checkout with an empty cart goes back to the cart', async () => {
  const res = await v.get('/checkout');
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], '/cart');
});

test('the form asks for name, email and delivery address, and nothing else', async () => {
  await v.add(P.mug.slug);
  const { body } = await openCheckout();
  const names = new Set([...body.matchAll(/<input[^>]+name="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(
    [...names].sort(),
    ['_csrf', 'city', 'country', 'email', 'expectedTotal', 'line1', 'line2', 'name', 'postcode', 'region', 'token'].sort(),
  );
  assert.ok(!/password|phone|birth/i.test(body.replace(/<p class="muted[^<]*<\/p>/g, '')));
});

test('the checkout page is never cached', async () => {
  await v.add(P.mug.slug);
  const res = await v.get('/checkout');
  assert.equal(res.headers['cache-control'], 'no-store');
});

// --- placing an order ------------------------------------------------------

test('placing an order stores one pending order with frozen totals and item snapshots', async () => {
  await v.add(P.mug.slug, 2);
  await v.applyCode(CODE);
  const { res, token } = await placeOrder();
  assert.equal(res.statusCode, 303);
  assert.match(String(res.headers['location']), /^\/checkout\/done(\?pay=unavailable)?$/);

  const [order, ...more] = await ordersFor(token);
  assert.ok(order);
  assert.equal(more.length, 0);
  assert.equal(order.status, 'pending');
  assert.equal(order.customer_id, null, 'a guest order has no account');
  assert.equal(order.subtotal_cents, 4800);
  assert.equal(order.discount_cents, 480);
  assert.equal(order.total_cents, 4800 - 480 + order.shipping_cents);
  assert.match(order.order_number, /^SO-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);

  const items = await getDb().selectFrom('order_items').selectAll().where('order_id', '=', order.id).execute();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.name_snapshot, P.mug.name);
  assert.equal(items[0]?.quantity, 2);
  assert.equal(items[0]?.line_total_cents, 4800);
});

test('the cart and code are cleared once the order is placed', async () => {
  await v.add(P.mug.slug);
  await v.applyCode(CODE);
  await placeOrder();
  assert.equal(v.jar.has(CART_COOKIE), false);
  assert.equal(v.jar.has(PROMO_COOKIE), false);
  assert.match((await v.get('/cart')).body, /Your cart is empty/);
});

test('name, email and address are stored encrypted, and only the store can read them back', async () => {
  await v.add(P.mug.slug);
  const { token } = await placeOrder();
  const [order] = await ordersFor(token);
  assert.ok(order);

  // What anyone with a copy of the database would see.
  const raw = Buffer.concat([order.email_enc, order.name_enc, order.address_enc]).toString('latin1');
  for (const secret of [CUSTOMER.email, CUSTOMER.name, CUSTOMER.line1, CUSTOMER.postcode, 'Zqx', 'Probe']) {
    assert.ok(!raw.includes(secret), `"${secret}" is readable in the stored bytes`);
  }

  assert.equal(decrypt(order.email_enc, 'orders.email'), CUSTOMER.email);
  assert.equal(decrypt(order.name_enc, 'orders.name'), CUSTOMER.name);
  assert.deepEqual(decryptAddress(order.address_enc), {
    line1: CUSTOMER.line1, line2: CUSTOMER.line2, city: CUSTOMER.city, region: CUSTOMER.region,
    postcode: CUSTOMER.postcode, country: CUSTOMER.country,
  });
  assert.equal(order.phone_enc, null, 'no phone number is asked for or stored');
});

test('the order can be found by email later without the email being stored readably', async () => {
  await v.add(P.mug.slug);
  const { token } = await placeOrder();
  const [order] = await ordersFor(token);
  assert.ok(order);
  const found = await getDb()
    .selectFrom('orders')
    .select('id')
    .where('order_number', '=', order.order_number)
    .where('email_bidx', '=', blindIndex(`  ${CUSTOMER.email.toUpperCase()} `, 'orders.email'))
    .executeTakeFirst();
  assert.equal(found?.id, order.id);
});

test('stock is not taken at checkout, only when an order is paid', async () => {
  await v.add(P.mug.slug, 3);
  await placeOrder();
  const row = await getDb().selectFrom('products').select('stock').where('id', '=', ids.mug).executeTakeFirstOrThrow();
  assert.equal(row.stock, 10);
});

test('the confirmation shows the order number and total, and nothing personal', async () => {
  await v.add(P.mug.slug);
  await placeOrder();
  const done = await v.get('/checkout/done');
  assert.equal(done.statusCode, 200);
  assert.match(done.body, /SO-[2-9A-Z]{4}-[2-9A-Z]{4}/);
  assert.match(done.body, /\$24\.00/);
  for (const secret of [CUSTOMER.name, CUSTOMER.email, CUSTOMER.line1, CUSTOMER.postcode]) {
    assert.ok(!done.body.includes(secret), `confirmation page shows "${secret}"`);
  }
  assert.equal(done.headers['cache-control'], 'no-store');
});

test('nothing personal is put in a URL or a cookie', async () => {
  await v.add(P.mug.slug);
  const { res } = await placeOrder();
  const exposed = [String(res.headers['location']), ...v.jar.values()].join(' ');
  for (const secret of [CUSTOMER.name, CUSTOMER.email, encodeURIComponent(CUSTOMER.email), CUSTOMER.postcode]) {
    assert.ok(!exposed.includes(secret), `"${secret}" leaked into a URL or cookie`);
  }
});

// --- one order per form ----------------------------------------------------

test('submitting the same form twice places one order', async () => {
  await v.add(P.mug.slug);
  const { csrf, token, expectedTotal } = await openCheckout();
  const cartCookie = v.jar.get(CART_COOKIE);
  await v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal });
  // The back button: same form, and the browser still sending the old cart.
  if (cartCookie !== undefined) v.jar.set(CART_COOKIE, cartCookie);
  const again = await v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal });
  assert.match(String(again.headers['location']), /^\/checkout\/done(\?pay=unavailable)?$/);
  assert.equal((await ordersFor(token)).length, 1);
});

test('a double-click, two submits at once, places one order', async () => {
  await v.add(P.mug.slug);
  const { csrf, token, expectedTotal } = await openCheckout();
  const results = await Promise.all([
    v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal }),
    v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode), [303, 303]);
  assert.equal((await ordersFor(token)).length, 1);
});

// --- when something changed ------------------------------------------------

test('if an item sold out after it was added, no order is placed and the cart says why', async () => {
  const db = getDb();
  await v.add(P.last.slug);
  const { csrf, token, expectedTotal } = await openCheckout();
  await db.updateTable('products').set({ stock: 0 }).where('id', '=', ids.last).execute();
  try {
    const res = await v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal });
    assert.equal(res.headers['location'], '/cart');
    assert.equal((await ordersFor(token)).length, 0);
    assert.match((await v.get('/cart')).body, /Checkout Probe Last has sold out/);
  } finally {
    await db.updateTable('products').set({ stock: 1 }).where('id', '=', ids.last).execute();
  }
});

test('if a price changed after the checkout page was opened, the new total is shown before any order', async () => {
  const db = getDb();
  await v.add(P.mug.slug);
  const { csrf, token, expectedTotal } = await openCheckout();
  await db.updateTable('products').set({ price_cents: 3000 }).where('id', '=', ids.mug).execute();
  try {
    const res = await v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /A price has changed/);
    assert.match(res.body, /\$30\.00/);
    assert.match(res.body, /value="Probe Customer Zqx"/, 'what they typed is kept');
    assert.equal((await ordersFor(token)).length, 0, 'no order at a total they did not see');

    // Placing it again from the refreshed page, at the total now shown, works.
    const again = /name="expectedTotal" value="([^"]+)"/.exec(res.body)?.[1] ?? '';
    const ok = await v.post('/checkout', { ...CUSTOMER, _csrf: csrf, token, expectedTotal: again });
    assert.match(String(ok.headers['location']), /^\/checkout\/done(\?pay=unavailable)?$/);
    assert.equal((await ordersFor(token))[0]?.subtotal_cents, 3000);
  } finally {
    await db.updateTable('products').set({ price_cents: 2400 }).where('id', '=', ids.mug).execute();
  }
});

// --- mistakes and misuse ---------------------------------------------------

test('missing or wrong fields are explained, what was typed is kept, and no order is placed', async () => {
  await v.add(P.mug.slug);
  const { csrf, token, expectedTotal } = await openCheckout();
  const res = await v.post('/checkout', {
    ...CUSTOMER, email: 'not-an-email', city: '', name: '<script>alert(1)</script>', _csrf: csrf, token, expectedTotal,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Please enter a valid email address/);
  assert.match(res.body, /Please enter your town or city/);
  assert.match(res.body, /value="12 Probe Street"/, 'typed values are kept');
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'and escaped');
  assert.ok(!res.body.includes('<script>alert(1)'));
  assert.equal((await ordersFor(token)).length, 0);
});

test('placing an order without a CSRF token is refused', async () => {
  await v.add(P.mug.slug);
  const { token, expectedTotal } = await openCheckout();
  const res = await v.post('/checkout', { ...CUSTOMER, token, expectedTotal }, false);
  assert.equal(res.statusCode, 403);
  assert.equal((await ordersFor(token)).length, 0);
});

test('the confirmation page needs the signed cookie from placing the order', async () => {
  assert.equal((await v.get('/checkout/done')).headers['location'], '/');
  v.jar.set(ORDER_COOKIE, randomUUID()); // unsigned, hand-made
  assert.equal((await v.get('/checkout/done')).headers['location'], '/');
});

test('repeated order attempts from one address are rate limited', async () => {
  await v.add(P.mug.slug);
  const { csrf, expectedTotal } = await openCheckout();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await v.post('/checkout', { ...CUSTOMER, email: 'bad', _csrf: csrf, token: randomUUID(), expectedTotal });
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses.slice(0, 5), Array(5).fill(400));
  assert.equal(statuses[5], 429);
});
