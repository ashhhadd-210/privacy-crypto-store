/**
 * Policy pages, dashboard and admin password change.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { hashPassword } from '../lib/session.js';
import { invalidateSettings } from '../lib/settings.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;
const RUN = randomBytes(4).toString('hex');
const ADMIN = `pages-admin-${RUN}@example.com`;
const PW = 'correct horse battery staple 1155';
let app: App;
let admin: Visitor;
let saved: { key: string; value: unknown }[] = [];

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  saved = await db.selectFrom('settings').select(['key', 'value']).where('key', 'like', 'page_%').execute();
  await db.insertInto('admin_users').values({ email: ADMIN, password_hash: await hashPassword(PW), totp_secret: null }).execute();
});

after(async () => {
  const db = getDb();
  await db.deleteFrom('settings').where('key', 'like', 'page_%').execute();
  for (const s of saved) await db.insertInto('settings').values({ key: s.key, value: JSON.stringify(s.value) }).execute();
  invalidateSettings();
  await db.deleteFrom('audit_log').where('actor', '=', ADMIN).execute();
  await db.deleteFrom('admin_users').where('email', '=', ADMIN).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/pages');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: ADMIN, password: PW })).headers['location'], '/admin');
  admin.jar = login.jar;
});

test('the three policy pages exist and are linked from every shop page', async () => {
  const shop = await app.inject({ method: 'GET', url: '/' });
  for (const path of ['/privacy', '/terms', '/shipping-returns']) {
    assert.match(shop.body, new RegExp(`href="${path}"`));
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 200, path);
  }
});

test('the starting privacy text states the real retention period', async () => {
  const res = await app.inject({ method: 'GET', url: '/privacy' });
  assert.match(res.body, /\d+ days after an order is finished/);
  assert.match(res.body, /no analytics, no advertising and no tracking/);
});

test('the admin can rewrite a page, and what they type is shown escaped', async () => {
  const res = await admin.post('/admin/pages', { terms: 'Our terms.\n\nSecond <script>alert(1)</script> paragraph.' });
  assert.equal(res.headers['location'], '/admin/pages?saved=1');
  const page = await app.inject({ method: 'GET', url: '/terms' });
  assert.match(page.body, /<p>Our terms\.<\/p>/);
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!page.body.includes('<script>alert(1)'));
});

test('editing pages needs an admin and a CSRF token', async () => {
  assert.equal((await new Visitor(app, '/admin/login').get('/admin/pages')).headers['location'], '/admin/login');
  assert.equal((await admin.post('/admin/pages', { terms: 'x' }, false)).statusCode, 403);
});

test('the dashboard shows what needs attention', async () => {
  const res = await admin.get('/admin');
  assert.match(res.body, /To ship/);
  assert.match(res.body, /Awaiting payment/);
  assert.match(res.body, /Change password/);
});

test('changing the admin password: wrong current refused, short refused, success signs out other sessions', async () => {
  const other = new Visitor(app, '/admin/login');
  assert.equal((await other.post('/admin/login', { email: ADMIN, password: PW })).headers['location'], '/admin');

  const tokenPage = '/admin/password';
  const pw = new Visitor(app, tokenPage);
  pw.jar = admin.jar;
  pw.ip = admin.ip;
  assert.match((await pw.post('/admin/password', { current: 'wrong', next: 'a brand new passphrase here', confirm: 'a brand new passphrase here' })).body, /current password is not correct/);
  assert.match((await pw.post('/admin/password', { current: PW, next: 'short', confirm: 'short' })).body, /at least 14 characters/);
  assert.match((await pw.post('/admin/password', { current: PW, next: 'a brand new passphrase here', confirm: 'different passphrase here!' })).body, /do not match/);

  const NEW = 'a brand new passphrase here';
  const ok = await pw.post('/admin/password', { current: PW, next: NEW, confirm: NEW });
  assert.equal(ok.headers['location'], '/admin?password=changed');
  assert.equal((await pw.get('/admin')).statusCode, 200, 'this session stays signed in');
  assert.equal((await other.get('/admin')).headers['location'], '/admin/login', 'the other session is signed out');

  const fresh = new Visitor(app, '/admin/login');
  assert.equal((await fresh.post('/admin/login', { email: ADMIN, password: NEW })).headers['location'], '/admin');
  // Put it back for the other tests in this file.
  await getDb().updateTable('admin_users').set({ password_hash: await hashPassword(PW) }).where('email', '=', ADMIN).execute();
});
