/**
 * Encrypted export tests: the file opens only with the client's secret key,
 * contains every order with its delivery details, marks orders exported, and
 * "export before deleting" holds back orders that were not exported.
 *
 *   npm test
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { generateIdentity, decrypt as ageDecrypt } from '../lib/age.js';

const CLIENT = generateIdentity();
const OTHER = generateIdentity();
process.env['EXPORT_AGE_RECIPIENT'] = CLIENT.recipient;

const { buildServer } = await import('../server.js');
const { blindIndex, encrypt, encryptAddress } = await import('../lib/crypto.js');
const { closeDb, getDb } = await import('../lib/db.js');
const { runPurge } = await import('../lib/retention.js');
const { hashPassword } = await import('../lib/session.js');
const { Visitor } = await import('../test/visitor.js');

type App = Awaited<ReturnType<typeof buildServer>>;
const RUN = randomBytes(3).toString('hex').toUpperCase();
const ADMIN = `export-admin-${RUN.toLowerCase()}@example.com`;
const PW = 'correct horse battery staple 2024';
const numbers: string[] = [];
let app: App;

async function order(status: 'complete' | 'paid', ageDays: number) {
  const number = `SO-X${RUN.slice(0, 3)}-${String(numbers.length).padStart(4, '0')}`;
  numbers.push(number);
  const email = `export.${RUN.toLowerCase()}.${numbers.length}@example.com`;
  const row = await getDb()
    .insertInto('orders')
    .values({
      order_number: number, customer_id: null, status,
      email_enc: encrypt(email, 'orders.email'), email_bidx: blindIndex(email, 'orders.email'),
      name_enc: encrypt(`Export Probe ${RUN}`, 'orders.name'),
      address_enc: encryptAddress({ line1: '8 Archive Row', city: 'Keepton', postcode: 'EX8 8AR', country: 'Probeland' }),
      phone_enc: null, subtotal_cents: 4200, total_cents: 4200, promotion_id: null, checkout_token: null, exported_at: null,
      tracking_number: null, admin_note: null, paid_at: null, shipped_at: null, completed_at: null,
      placed_at: new Date(Date.now() - ageDays * 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, number, email };
}

async function admin() {
  const v = new Visitor(app, '/admin/export');
  const login = new Visitor(app, '/admin/login');
  login.ip = v.ip;
  assert.equal((await login.post('/admin/login', { email: ADMIN, password: PW })).headers['location'], '/admin');
  v.jar = login.jar;
  return v;
}

before(async () => {
  app = await buildServer();
  await app.ready();
  await getDb().insertInto('admin_users').values({ email: ADMIN, password_hash: await hashPassword(PW), totp_secret: null }).execute();
});

after(async () => {
  const db = getDb();
  if (numbers.length > 0) await db.deleteFrom('orders').where('order_number', 'in', numbers).execute();
  await db.deleteFrom('audit_log').where('actor', '=', ADMIN).execute();
  await db.deleteFrom('admin_users').where('email', '=', ADMIN).execute();
  await app.close();
  await closeDb();
});

test('the export page needs a signed-in admin', async () => {
  assert.equal((await new Visitor(app, '/admin/login').get('/admin/export')).headers['location'], '/admin/login');
});

test('the download is locked to the client key, holds every order with its details, and marks them exported', async () => {
  const a = await order('complete', 3);
  const v = await admin();
  const page = await v.get('/admin/export');
  assert.match(page.body, /Download encrypted export/);

  const res = await v.post('/admin/export', {});
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="store-export-\d{8}-\d{4}\.json\.age"/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const file = res.rawPayload;
  assert.ok(!file.includes(Buffer.from(a.email)), 'nothing readable in the file');
  assert.ok(!file.includes(Buffer.from('Archive Row')));

  assert.throws(() => ageDecrypt(file, OTHER.identity), /no matching recipient/);
  const doc = JSON.parse(ageDecrypt(file, CLIENT.identity).toString()) as { orders: { order_number: string; customer: { email: string; address: { line1: string } }; total: number }[] };
  const mine = doc.orders.find((o) => o.order_number === a.number);
  assert.ok(mine);
  assert.equal(mine.customer.email, a.email);
  assert.equal(mine.customer.address.line1, '8 Archive Row');
  assert.equal(mine.total, 4200);

  const row = await getDb().selectFrom('orders').select('exported_at').where('id', '=', a.id).executeTakeFirstOrThrow();
  assert.ok(row.exported_at);
  const log = await getDb().selectFrom('audit_log').select('action').where('actor', '=', ADMIN).where('action', '=', 'export.download').execute();
  assert.ok(log.length >= 1);
});

test('export needs a CSRF token', async () => {
  const v = await admin();
  assert.equal((await v.post('/admin/export', {}, false)).statusCode, 403);
});

test('with "export before deleting" on, an unexported old order is kept until it is exported', async () => {
  const db = getDb();
  const kept = await order('complete', 60);
  const settings = { retention_days: 30, purge_enabled: true, export_before_purge: true };
  await runPurge(db, 'schedule', { settings });
  assert.ok(await db.selectFrom('orders').select('id').where('id', '=', kept.id).executeTakeFirst(), 'not exported: kept');

  await db.updateTable('orders').set({ exported_at: new Date() }).where('id', '=', kept.id).execute();
  await runPurge(db, 'schedule', { settings });
  assert.equal(await db.selectFrom('orders').select('id').where('id', '=', kept.id).executeTakeFirst(), undefined, 'exported: deleted');
});
