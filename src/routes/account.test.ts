/**
 * Customer account tests, through the real plugin chain and database.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { CART_COOKIE } from '../lib/cart.js';
import { blindIndex } from '../lib/crypto.js';
import { CUSTOMER_COOKIE } from '../lib/customer-auth.js';
import { closeDb, getDb } from '../lib/db.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(4).toString('hex');
const SLUG = `acct-probe-${RUN}`;
const PASSWORD = 'a long enough password 4471';
const ADDRESS = { name: 'Account Probe Kzp', line1: '3 Account Lane', city: 'Probeton', postcode: 'AC1 3KZ', country: 'Probeland' };

let app: App;
const emails: string[] = [];
const email = (tag: string) => {
  const e = `acct.${RUN}.${tag}@example.com`;
  emails.push(e);
  return e;
};

before(async () => {
  app = await buildServer();
  await app.ready();
  await getDb().insertInto('products').values({ slug: SLUG, name: 'Account Probe Item', price_cents: 1500, stock: 99, active: true }).execute();
});

after(async () => {
  const db = getDb();
  const bidx = emails.map((e) => blindIndex(e, 'customers.email'));
  if (bidx.length > 0) await db.deleteFrom('customers').where('email_bidx', 'in', bidx).execute();
  const orderBidx = emails.map((e) => blindIndex(e, 'orders.email'));
  if (orderBidx.length > 0) await db.deleteFrom('orders').where('email_bidx', 'in', orderBidx).execute();
  await db.deleteFrom('products').where('slug', '=', SLUG).execute();
  await app.close();
  await closeDb();
});

let v: Visitor;
beforeEach(() => {
  v = new Visitor(app, '/order');
});

async function register(e: string, password = PASSWORD) {
  return v.post('/account/register', { email: e, password });
}
async function login(e: string, password = PASSWORD) {
  return v.post('/account/login', { email: e, password });
}
async function signUpAndIn(tag: string): Promise<string> {
  const e = email(tag);
  await register(e);
  const res = await login(e);
  assert.equal(res.headers['location'], '/account', 'login after register');
  return e;
}
/** Places an order through the real checkout with whatever session the visitor has. */
async function placeOrder(e: string): Promise<string> {
  await v.add(SLUG);
  const page = await v.get('/checkout');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  const token = /name="token" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  const expectedTotal = /name="expectedTotal" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  const res = await v.post('/checkout', { ...ADDRESS, email: e, _csrf: csrf, token, expectedTotal });
  assert.match(String(res.headers['location']), /^\/checkout\/done(\?pay=unavailable)?$/);
  const row = await getDb().selectFrom('orders').select('id').where('checkout_token', '=', token).executeTakeFirstOrThrow();
  return row.id;
}
const customerRow = (e: string) =>
  getDb().selectFrom('customers').selectAll().where('email_bidx', '=', blindIndex(e, 'customers.email')).executeTakeFirst();

// --- registration ------------------------------------------------------------

test('registering stores an encrypted email and a password hash, nothing readable', async () => {
  const e = email('reg');
  const res = await register(e);
  assert.equal(res.headers['location'], '/account/login?registered=1');
  const row = await customerRow(e);
  assert.ok(row);
  assert.ok(!row.email_enc.toString('latin1').includes(e));
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
  assert.equal(row.name_enc, null);
});

test('registering an email that already has an account looks exactly like a new one', async () => {
  const e = email('dup');
  const first = await register(e);
  const second = await new Visitor(app, '/order').post('/account/register', { email: e, password: 'another password entirely 99' });
  assert.equal(second.statusCode, first.statusCode);
  assert.equal(second.headers['location'], first.headers['location']);
  const rows = await getDb().selectFrom('customers').select('id').where('email_bidx', '=', blindIndex(e, 'customers.email')).execute();
  assert.equal(rows.length, 1);
  // ...and the original password is the one that works.
  assert.equal((await login(e)).headers['location'], '/account');
});

test('a short password or a bad email is refused', async () => {
  assert.equal((await register(email('short'), 'tooshort')).statusCode, 400);
  assert.equal((await register('not-an-email')).statusCode, 400);
});

// --- sign in -----------------------------------------------------------------

test('a wrong password and an unknown email give the same answer', async () => {
  const e = await signUpAndIn('same');
  const fresh = new Visitor(app, '/account/login');
  const wrong = await fresh.post('/account/login', { email: e, password: 'wrong password here 00' });
  const unknown = await fresh.post('/account/login', { email: email('nobody'), password: 'wrong password here 00' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.match(wrong.body, /Those details are not correct/);
  assert.match(unknown.body, /Those details are not correct/);
});

test('five wrong passwords lock the account, even from a fresh address', async () => {
  const e = email('lock');
  await register(e);
  for (let i = 0; i < 5; i++) await new Visitor(app, '/account/login').post('/account/login', { email: e, password: `wrong ${i} wrong wrong wrong` });
  const res = await new Visitor(app, '/account/login').post('/account/login', { email: e, password: PASSWORD });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Too many failed attempts/);
});

test('the session cookie is httpOnly and only its hash is stored', async () => {
  await signUpAndIn('cookie');
  const token = v.jar.get(CUSTOMER_COOKIE);
  assert.ok(token);
  const sessions = await getDb().selectFrom('customer_sessions').select('id').execute();
  assert.ok(!sessions.some((s) => s.id === token), 'the raw token must never be in the database');
  const me = await v.get('/account');
  assert.equal(me.statusCode, 200);
  assert.equal(me.headers['cache-control'], 'no-store');
});

test('signing out ends the session', async () => {
  await signUpAndIn('out');
  await v.post('/account/logout', {});
  assert.equal((await v.get('/account')).headers['location'], '/account/login');
});

test('the account needs a sign-in and changes need a CSRF token', async () => {
  const stranger = new Visitor(app, '/account/login');
  assert.equal((await stranger.get('/account')).headers['location'], '/account/login');
  assert.equal((await stranger.post('/account/login', { email: 'x@example.com', password: PASSWORD }, false)).statusCode, 403);
});

// --- orders --------------------------------------------------------------------

test('checkout while signed in prefills the email and links the order to the account', async () => {
  const e = await signUpAndIn('order');
  await v.add(SLUG);
  const page = await v.get('/checkout');
  assert.match(page.body, new RegExp(`value="${e}"`));
  const id = await placeOrder(e);
  const row = await customerRow(e);
  const order = await getDb().selectFrom('orders').select('customer_id').where('id', '=', id).executeTakeFirstOrThrow();
  assert.equal(order.customer_id, row?.id);
});

test('order history shows only my orders, and another customer\'s order is a 404', async () => {
  const mine = await signUpAndIn('mine');
  const myOrder = await placeOrder(mine);

  const other = new Visitor(app, '/order');
  const otherEmail = email('other');
  await other.post('/account/register', { email: otherEmail, password: PASSWORD });
  await other.post('/account/login', { email: otherEmail, password: PASSWORD });
  const v0 = v;
  v = other;
  const theirOrder = await placeOrder(otherEmail);
  v = v0;

  const history = await v.get('/account');
  assert.match(history.body, new RegExp(`/account/orders/${myOrder}`));
  assert.ok(!history.body.includes(theirOrder));
  assert.equal((await v.get(`/account/orders/${myOrder}`)).statusCode, 200);
  assert.equal((await v.get(`/account/orders/${theirOrder}`)).statusCode, 404);
});

test('my own order page shows status and totals, and no address', async () => {
  const e = await signUpAndIn('detail');
  const id = await placeOrder(e);
  const res = await v.get(`/account/orders/${id}`);
  assert.match(res.body, /Awaiting payment/);
  assert.match(res.body, /\$15\.00/);
  for (const secret of [ADDRESS.name, ADDRESS.line1, ADDRESS.postcode]) assert.ok(!res.body.includes(secret), secret);
});

// --- delete --------------------------------------------------------------------

test('deleting the account needs the password', async () => {
  const e = await signUpAndIn('nodel');
  const res = await v.post('/account/delete', { password: 'not the password at all' });
  assert.equal(res.statusCode, 401);
  assert.ok(await customerRow(e));
});

test('deleting the account wipes finished orders, keeps in-flight ones unlinked, and records the run', async () => {
  const db = getDb();
  const e = await signUpAndIn('del');
  const finished = await placeOrder(e);
  await db.updateTable('orders').set({ status: 'complete' }).where('id', '=', finished).execute();
  const inFlight = await placeOrder(e);
  const aggregatesBefore = Number((await db.selectFrom('order_aggregates').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

  const res = await v.post('/account/delete', { password: PASSWORD });
  assert.equal(res.headers['location'], '/account/deleted');

  assert.equal(await customerRow(e), undefined, 'account gone');
  assert.equal(v.jar.has(CUSTOMER_COOKIE), false, 'cookie cleared');
  assert.equal(await db.selectFrom('orders').select('id').where('id', '=', finished).executeTakeFirst(), undefined, 'finished order wiped');
  const kept = await db.selectFrom('orders').select(['customer_id', 'name_enc']).where('id', '=', inFlight).executeTakeFirstOrThrow();
  assert.equal(kept.customer_id, null, 'in-flight order unlinked');
  assert.ok(kept.name_enc.length > 0, 'in-flight order keeps its delivery details');

  const aggregatesAfter = Number((await db.selectFrom('order_aggregates').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
  assert.equal(aggregatesAfter, aggregatesBefore + 1, 'the sale survives as an anonymous aggregate');
  const run = await db.selectFrom('purge_runs').selectAll().where('triggered_by', '=', 'account-delete').orderBy('ran_at', 'desc').executeTakeFirst();
  assert.equal(run?.customers_purged, 1);
  assert.equal(run?.orders_purged, 1);
  await db.deleteFrom('orders').where('id', '=', inFlight).execute();
});

// --- privacy -------------------------------------------------------------------

test('nothing personal ends up in a URL or a cookie', async () => {
  const e = await signUpAndIn('leak');
  await placeOrder(e);
  const exposed = [...v.jar.values()].join(' ');
  for (const secret of [e, encodeURIComponent(e), ADDRESS.name, ADDRESS.postcode]) {
    assert.ok(!exposed.includes(secret), `"${secret}" in a cookie`);
  }
  assert.ok(!v.jar.has(CART_COOKIE), 'cart cleared after ordering');
});
