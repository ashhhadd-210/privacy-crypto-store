/**
 * Cart tests, through the real plugin chain: cookies, signing, CSRF and the
 * error handler. They create their own products and delete them afterwards,
 * because the other test files read the seeded catalogue in parallel.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { CART_COOKIE, MAX_QTY, PROMO_COOKIE } from '../lib/cart.js';
import { closeDb, getDb } from '../lib/db.js';
import { type Res, Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(4).toString('hex');
const P = {
  plenty: { slug: `cart-${RUN}-plenty`, name: 'Cart Probe Plenty', price_cents: 2400, stock: 25, track_stock: true },
  last: { slug: `cart-${RUN}-last`, name: 'Cart Probe Last One', price_cents: 1250, stock: 1, track_stock: true },
  none: { slug: `cart-${RUN}-none`, name: 'Cart Probe Sold Out', price_cents: 999, stock: 0, track_stock: true },
  untracked: { slug: `cart-${RUN}-untracked`, name: 'Cart Probe Untracked', price_cents: 500, stock: 0, track_stock: false },
  hidden: { slug: `cart-${RUN}-hidden`, name: 'Cart Probe Hidden', price_cents: 100, stock: 5, track_stock: true },
};

const DAY = 86_400_000;
const CODES = {
  pct10: { code: `PCT10-${RUN}`.toUpperCase(), type: 'percent' as const, value: 10 },
  pct15: { code: `PCT15-${RUN}`.toUpperCase(), type: 'percent' as const, value: 15 },
  fixed: { code: `FIX5-${RUN}`.toUpperCase(), type: 'fixed' as const, value: 500, min_subtotal_cents: 5000 },
  huge: { code: `HUGE-${RUN}`.toUpperCase(), type: 'fixed' as const, value: 100_000 },
  expired: { code: `OLD-${RUN}`.toUpperCase(), type: 'percent' as const, value: 50, ends_at: new Date(Date.now() - DAY) },
  future: { code: `SOON-${RUN}`.toUpperCase(), type: 'percent' as const, value: 50, starts_at: new Date(Date.now() + DAY) },
  usedUp: { code: `USED-${RUN}`.toUpperCase(), type: 'percent' as const, value: 50, max_uses: 3, used_count: 3 },
  off: { code: `OFF-${RUN}`.toUpperCase(), type: 'percent' as const, value: 50, active: false },
  later: { code: `LATER-${RUN}`.toUpperCase(), type: 'percent' as const, value: 20 },
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
      .values({ ...p, description: '', active: key !== 'hidden', sort_order: 9000 })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[key] = row.id;
  }
  await db.insertInto('promotions').values(Object.values(CODES)).execute();
});

after(async () => {
  await getDb().deleteFrom('products').where('slug', 'like', `cart-${RUN}-%`).execute();
  await getDb().deleteFrom('promotions').where('code', 'in', Object.values(CODES).map((c) => c.code)).execute();
  await app.close();
  await closeDb();
});

beforeEach(() => {
  v = new Visitor(app, `/p/${P.plenty.slug}`);
});

// --- adding ----------------------------------------------------------------

test('an empty cart says so', async () => {
  const res = await v.get('/cart');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Your cart is empty/);
});

test('adding a product puts it in the cart and totals it in exact money', async () => {
  const res = await v.add(P.plenty.slug);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], '/cart?msg=added');

  await v.add(P.plenty.slug, 2);
  const cart = await v.get('/cart');
  assert.match(cart.body, /Cart Probe Plenty/);
  assert.match(cart.body, /\$24\.00 each/);
  assert.match(cart.body, /\$72\.00/);
  assert.match(cart.body, /Cart \(3\)/, 'the header shows the item count');
});

test('the last unit cannot be added twice', async () => {
  await v.add(P.last.slug);
  const second = await v.add(P.last.slug);
  assert.equal(second.headers['location'], '/cart?msg=limited');

  const cart = await v.get(String(second.headers['location']));
  assert.match(cart.body, /as many as we can sell you/);
  assert.match(cart.body, /value="1"/);
  assert.match(cart.body, /\$12\.50/);
});

test('a sold-out product cannot be added at all', async () => {
  const res = await v.add(P.none.slug);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], `/p/${P.none.slug}`);
  assert.equal(v.jar.has(CART_COOKIE), false, 'no cart is created');
});

test('a product with stock tracking off can be added despite zero stock', async () => {
  await v.add(P.untracked.slug, 4);
  const cart = await v.get('/cart');
  assert.match(cart.body, /Cart Probe Untracked/);
  assert.match(cart.body, /\$20\.00/);
});

test('a hidden product cannot be added, and looks like one that never existed', async () => {
  const hidden = await v.add(P.hidden.slug);
  const nonsense = await v.add('no-such-product');
  assert.equal(hidden.statusCode, 404);
  assert.equal(nonsense.statusCode, 404);
});

test(`quantities are capped at ${MAX_QTY} per product`, async () => {
  await v.add(P.untracked.slug, MAX_QTY);
  const res = await v.add(P.untracked.slug, 1);
  assert.equal(res.headers['location'], '/cart?msg=limited');
  const cart = await v.get('/cart');
  assert.match(cart.body, new RegExp(`value="${MAX_QTY}"`));
});

// --- changing --------------------------------------------------------------

test('quantity can be changed, and zero removes the line', async () => {
  await v.add(P.plenty.slug);
  await v.post('/cart/update', { productId: ids.plenty, qty: '5' });
  assert.match((await v.get('/cart')).body, /\$120\.00/);

  await v.post('/cart/update', { productId: ids.plenty, qty: '0' });
  assert.match((await v.get('/cart')).body, /Your cart is empty/);
});

test('remove takes the line out', async () => {
  await v.add(P.plenty.slug);
  await v.add(P.untracked.slug);
  await v.post('/cart/remove', { productId: ids.plenty });
  const cart = await v.get('/cart');
  assert.ok(!cart.body.includes('Cart Probe Plenty'));
  assert.match(cart.body, /Cart Probe Untracked/);
});

test('asking for more than is in stock is corrected, with a reason', async () => {
  await v.add(P.last.slug);
  await v.post('/cart/update', { productId: ids.last, qty: '4' });
  const cart = await v.get('/cart');
  assert.match(cart.body, /Only 1 of Cart Probe Last One left/);
  assert.match(cart.body, /value="1"/);
});

test('nonsense quantities are refused', async () => {
  await v.add(P.plenty.slug);
  for (const qty of ['-1', '2.5', 'lots', String(MAX_QTY + 1)]) {
    const res = await v.post('/cart/update', { productId: ids.plenty, qty });
    assert.equal(res.statusCode, 400, `qty=${qty}`);
  }
});

// --- the database wins -----------------------------------------------------

test('a product that sells out after being added is removed, and the page says why', async () => {
  const db = getDb();
  await v.add(P.plenty.slug);
  await db.updateTable('products').set({ stock: 0 }).where('id', '=', ids.plenty).execute();
  try {
    const cart = await v.get('/cart');
    assert.match(cart.body, /Cart Probe Plenty has sold out and was removed/);
    assert.match(cart.body, /Your cart is empty/);
  } finally {
    await db.updateTable('products').set({ stock: 25 }).where('id', '=', ids.plenty).execute();
  }
});

test('a product hidden after being added disappears without being named', async () => {
  const db = getDb();
  await db.updateTable('products').set({ active: true }).where('id', '=', ids.hidden).execute();
  await v.add(P.hidden.slug);
  await db.updateTable('products').set({ active: false }).where('id', '=', ids.hidden).execute();

  const cart = await v.get('/cart');
  assert.match(cart.body, /An item in your cart is no longer available/);
  assert.ok(!cart.body.includes('Cart Probe Hidden'), 'a hidden product must not be named');
});

test('a price change after adding is picked up, because the cookie holds no prices', async () => {
  const db = getDb();
  await v.add(P.plenty.slug);
  await db.updateTable('products').set({ price_cents: 3000 }).where('id', '=', ids.plenty).execute();
  try {
    assert.match((await v.get('/cart')).body, /\$30\.00 each/);
  } finally {
    await db.updateTable('products').set({ price_cents: 2400 }).where('id', '=', ids.plenty).execute();
  }
});

// --- tampering and forgery -------------------------------------------------

test('a tampered cart cookie is an empty cart, not an error', async () => {
  await v.add(P.last.slug);
  const signed = v.jar.get(CART_COOKIE) ?? '';
  v.jar.set(CART_COOKIE, signed.replace(':1', ':9'));
  const cart = await v.get('/cart');
  assert.equal(cart.statusCode, 200);
  assert.match(cart.body, /Your cart is empty/);
});

test('changing the cart without a CSRF token is refused', async () => {
  await v.token(); // a real visitor with the CSRF cookie, but no token in the form
  const res = await v.post('/cart/add', { slug: P.plenty.slug }, false);
  assert.equal(res.statusCode, 403);
  assert.equal(v.jar.has(CART_COOKIE), false);
});

// --- privacy ---------------------------------------------------------------

test('the cart cookie holds product ids and quantities only, and scripts cannot read it', async () => {
  const res = await v.add(P.plenty.slug, 2);
  const cookie = (res.cookies as { name: string; value: string; httpOnly?: boolean; sameSite?: string; expires?: Date; maxAge?: number }[])
    .find((c) => c.name === CART_COOKIE);
  assert.ok(cookie);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.expires, undefined, 'a session cookie: gone when the browser closes');
  assert.equal(cookie.maxAge, undefined);

  const payload = cookie.value.slice(0, cookie.value.lastIndexOf('.'));
  assert.equal(payload, `${ids.plenty}:2`);
});

test('the cart page is never cached', async () => {
  await v.add(P.plenty.slug);
  const res = await v.get('/cart');
  assert.equal(res.headers['cache-control'], 'no-store');
});

// --- discount codes --------------------------------------------------------

const total = (amount: string) => new RegExp(`Total</span> <strong>\\$${amount.replace('.', '\\.')}<`);

test('a percentage code takes exactly that much off', async () => {
  await v.add(P.plenty.slug, 3);
  const res = await v.applyCode(CODES.pct10.code);
  assert.equal(res.headers['location'], '/cart?msg=code_applied');

  const cart = await v.get('/cart');
  assert.match(cart.body, /\$72\.00/);
  assert.match(cart.body, /&minus;\$7\.20/);
  assert.match(cart.body, total('64.80'));
});

test('a percentage discount rounds down to the cent, never in the customer\'s favour', async () => {
  await v.add(P.last.slug); // $12.50; 15% is $1.875
  await v.applyCode(CODES.pct15.code);
  const cart = await v.get('/cart');
  assert.match(cart.body, /&minus;\$1\.87/);
  assert.match(cart.body, total('10.63'));
});

test('codes ignore case and surrounding spaces', async () => {
  await v.add(P.plenty.slug);
  const res = await v.applyCode(`  ${CODES.pct10.code.toLowerCase()}  `);
  assert.equal(res.headers['location'], '/cart?msg=code_applied');
});

test('every unusable code gets the same answer, so codes cannot be discovered', async () => {
  await v.add(P.plenty.slug);
  for (const code of ['NO-SUCH-CODE', CODES.expired.code, CODES.future.code, CODES.usedUp.code, CODES.off.code]) {
    const res = await v.applyCode(code);
    assert.equal(res.headers['location'], '/cart?msg=code_invalid', code);
    assert.equal(v.jar.has(PROMO_COOKIE), false, code);
  }
  assert.match((await v.get('/cart?msg=code_invalid')).body, /That code is not valid/);
});

test('below the minimum spend, the code waits and says how much more is needed', async () => {
  await v.add(P.plenty.slug); // $24.00, minimum $50.00
  await v.applyCode(CODES.fixed.code);
  let cart = await v.get('/cart');
  assert.match(cart.body, /Add \$26\.00 more to use this code/);
  assert.match(cart.body, total('24.00'));

  await v.add(P.plenty.slug, 2); // $72.00
  cart = await v.get('/cart');
  assert.match(cart.body, /&minus;\$5\.00/);
  assert.match(cart.body, total('67.00'));
});

test('a fixed discount can never take the total below zero', async () => {
  await v.add(P.plenty.slug);
  await v.applyCode(CODES.huge.code);
  const cart = await v.get('/cart');
  assert.match(cart.body, total('0.00'));
});

test('a code that stops being valid while in the cart is dropped, with a reason', async () => {
  const db = getDb();
  await v.add(P.plenty.slug);
  await v.applyCode(CODES.later.code);
  await db.updateTable('promotions').set({ active: false }).where('code', '=', CODES.later.code).execute();
  try {
    const cart = await v.get('/cart');
    assert.match(cart.body, /no longer valid and was removed/);
    assert.match(cart.body, total('24.00'));
    assert.equal(v.jar.has(PROMO_COOKIE), false);
  } finally {
    await db.updateTable('promotions').set({ active: true }).where('code', '=', CODES.later.code).execute();
  }
});

test('a code can be removed', async () => {
  await v.add(P.plenty.slug);
  await v.applyCode(CODES.pct10.code);
  await v.post('/cart/promo/remove', {});
  const cart = await v.get('/cart');
  assert.ok(!cart.body.includes(CODES.pct10.code));
  assert.match(cart.body, total('24.00'));
});

test('a hand-made discount cookie is ignored', async () => {
  await v.add(P.plenty.slug);
  v.jar.set(PROMO_COOKIE, CODES.huge.code); // unsigned
  const cart = await v.get('/cart');
  assert.match(cart.body, total('24.00'));
});

test('guessing codes is rate limited', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await v.applyCode(`GUESS-${i}`)).statusCode);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(303));
  assert.equal(statuses[10], 429);
});
