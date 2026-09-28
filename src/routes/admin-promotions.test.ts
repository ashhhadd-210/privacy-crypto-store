/**
 * Admin discount code tests: the form's rules, and that what the admin sets
 * is what the cart then does.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { hashPassword } from '../lib/session.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(3).toString('hex').toUpperCase();
const EMAIL = `admin-promos-${RUN.toLowerCase()}@example.com`;
const PASSWORD = 'correct horse battery staple 7702';
const SLUG = `promo-probe-${RUN.toLowerCase()}`;

let app: App;
let admin: Visitor;
const codes: string[] = [];

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  await db.insertInto('admin_users').values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null }).execute();
  await db.insertInto('products').values({ slug: SLUG, name: 'Promo Probe', price_cents: 5000, stock: 50, active: true }).execute();
});

after(async () => {
  const db = getDb();
  if (codes.length > 0) await db.deleteFrom('promotions').where('code', 'in', codes).execute();
  await db.deleteFrom('products').where('slug', '=', SLUG).execute();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/promotions/new');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: EMAIL, password: PASSWORD })).headers['location'], '/admin');
  admin.jar = login.jar;
});

const code = (suffix: string) => {
  const c = `T${RUN}-${suffix}`;
  codes.push(c);
  return c;
};

async function create(fields: Record<string, string>) {
  return admin.post('/admin/promotions', { type: 'percent', active: 'on', ...fields });
}

/** A shopper applies the code to a $50.00 cart and reports the total. */
async function totalWith(c: string): Promise<string | undefined> {
  const shopper = new Visitor(app, `/p/${SLUG}`);
  await shopper.add(SLUG);
  await shopper.applyCode(c);
  return /Total<\/span> <strong>([^<]+)</.exec((await shopper.get('/cart')).body)?.[1];
}

test('discount codes need a signed-in admin', async () => {
  const res = await new Visitor(app, '/admin/login').get('/admin/promotions');
  assert.equal(res.headers['location'], '/admin/login');
});

test('a new code is stored in capitals and works in the cart straight away', async () => {
  const c = code('PCT');
  const res = await create({ code: c.toLowerCase(), value: '20' });
  assert.match(String(res.headers['location']), /^\/admin\/promotions\/[0-9a-f-]{36}\?saved=1$/);
  const row = await getDb().selectFrom('promotions').selectAll().where('code', '=', c).executeTakeFirstOrThrow();
  assert.equal(row.type, 'percent');
  assert.equal(row.value, 20);
  assert.equal(await totalWith(c), '$40.00');
});

test('a fixed-amount code with a minimum spend is stored in exact cents', async () => {
  const c = code('FIX');
  await create({ code: c, type: 'fixed', value: '7.50', min_spend: '40' });
  const row = await getDb().selectFrom('promotions').selectAll().where('code', '=', c).executeTakeFirstOrThrow();
  assert.equal(row.value, 750);
  assert.equal(row.min_subtotal_cents, 4000);
  assert.equal(await totalWith(c), '$42.50');
});

test('the same code cannot exist twice, whatever the capitals', async () => {
  const c = code('DUP');
  await create({ code: c, value: '10' });
  const res = await create({ code: c.toLowerCase(), value: '15' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /That code already exists/);
});

test('mistakes are explained and nothing is saved', async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ code: 'x', value: '10' }, /3 to 40 letters/],
    [{ code: code('BADPCT'), value: '0' }, /whole percentage from 1 to 100/],
    [{ code: code('BIGPCT'), value: '101' }, /whole percentage from 1 to 100/],
    [{ code: code('FRAC'), value: '2.5' }, /whole percentage/],
    [{ code: code('BADAMT'), type: 'fixed', value: 'abc' }, /amount like 5 or 5\.50/],
    [{ code: code('DATES'), value: '10', starts: '2026-10-10', ends: '2026-10-01' }, /last day must be on or after the first/],
    [{ code: code('BADDAY'), value: '10', starts: '2026-02-30' }, /Pick a date/],
    [{ code: code('USES'), value: '10', max_uses: '0' }, /whole number/],
  ];
  for (const [fields, message] of cases) {
    const res = await create(fields);
    assert.equal(res.statusCode, 400, JSON.stringify(fields));
    assert.match(res.body, message, JSON.stringify(fields));
  }
  const saved = await getDb().selectFrom('promotions').select('code').where('code', 'like', `T${RUN}-%`).execute();
  assert.ok(!saved.some((s) => ['BADPCT', 'BIGPCT', 'FRAC', 'BADAMT', 'DATES', 'BADDAY', 'USES'].some((x) => s.code.endsWith(x))));
});

test('the last day counts: a code ending today still works today', async () => {
  const c = code('TODAY');
  const today = new Date().toISOString().slice(0, 10);
  await create({ code: c, value: '10', starts: today, ends: today });
  assert.equal(await totalWith(c), '$45.00');
});

test('a code starting tomorrow does not work yet', async () => {
  const c = code('LATER');
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await create({ code: c, value: '10', starts: tomorrow });
  assert.equal(await totalWith(c), '$50.00');
  assert.match((await admin.get('/admin/promotions')).body, new RegExp(`${c}[\\s\\S]*?Scheduled`));
});

test('switching a code off stops it working at once', async () => {
  const c = code('OFF');
  const res = await create({ code: c, value: '10' });
  const id = /promotions\/([0-9a-f-]{36})/.exec(String(res.headers['location']))?.[1];
  assert.ok(id);
  await admin.post(`/admin/promotions/${id}`, { code: c, type: 'percent', value: '10' }); // no "active"
  assert.equal(await totalWith(c), '$50.00');
});

test('changes need a CSRF token, and every change is recorded', async () => {
  const c = code('LOG');
  assert.equal((await admin.post('/admin/promotions', { code: c, type: 'percent', value: '10' }, false)).statusCode, 403);
  const res = await create({ code: c, value: '10' });
  const id = /promotions\/([0-9a-f-]{36})/.exec(String(res.headers['location']))?.[1];
  assert.ok(id);
  await admin.post(`/admin/promotions/${id}`, { code: c, type: 'percent', value: '12', active: 'on' });
  const log = await getDb().selectFrom('audit_log').select(['action', 'metadata']).where('entity_id', '=', id).orderBy('created_at').execute();
  assert.deepEqual(log.map((l) => l.action), ['promotion.create', 'promotion.update']);
  assert.deepEqual((log[1]?.metadata as { changed: string[] }).changed, ['value']);
});
