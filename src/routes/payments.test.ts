/**
 * Payment tests, end to end: checkout -> BTCPay invoice -> signed webhook ->
 * paid order, stock, discount count and emails. BTCPay is a local fake that
 * speaks the three Greenfield calls we use and records what it was sent; the
 * mail transport records instead of sending.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const SECRET = randomBytes(24).toString('hex');
const API_KEY = randomBytes(16).toString('hex');
const STORE = 'teststore';

// --- the fake BTCPay -----------------------------------------------------------
interface FakeInvoice { id: string; status: string; additionalStatus?: string; amount: string; metadata: Record<string, unknown> }
const invoices = new Map<string, FakeInvoice>();
const received: string[] = [];
let btcpayDown = false;
let fake: Server;

function startFake(): Promise<string> {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body);
      if (btcpayDown) return void res.writeHead(503).end();
      if (req.headers['authorization'] !== `token ${API_KEY}`) return void res.writeHead(401).end();
      const base = `/api/v1/stores/${STORE}/invoices`;
      const json = (code: number, v: unknown) => void res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      const view = (i: FakeInvoice) => ({ ...i, checkoutLink: `https://pay.example/i/${i.id}`, currency: 'USD', expirationTime: Math.floor(Date.now() / 1000) + 3600 });
      if (req.method === 'POST' && req.url === base) {
        const b = JSON.parse(body) as { amount: string; metadata: Record<string, unknown> };
        const inv = { id: `inv_${randomBytes(6).toString('hex')}`, status: 'New', amount: b.amount, metadata: b.metadata };
        invoices.set(inv.id, inv);
        return json(200, view(inv));
      }
      const m = /^\/api\/v1\/stores\/teststore\/invoices\/([^/]+)(\/status)?$/.exec(req.url ?? '');
      const inv = m ? invoices.get(m[1] as string) : undefined;
      if (inv === undefined) return json(404, {});
      if (req.method === 'POST' && m?.[2]) { inv.status = (JSON.parse(body) as { status: string }).status; return json(200, view(inv)); }
      return json(200, view(inv));
    });
  });
  return new Promise((r) => fake.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(fake.address() as AddressInfo).port}`)));
}

const url = await startFake();
process.env['BTCPAY_URL'] = url;
process.env['BTCPAY_STORE_ID'] = STORE;
process.env['BTCPAY_API_KEY'] = API_KEY;
process.env['BTCPAY_WEBHOOK_SECRET'] = SECRET;

const { buildServer } = await import('../server.js');
const { blindIndex } = await import('../lib/crypto.js');
const { closeDb, getDb } = await import('../lib/db.js');
const { processOutbox, setTransport } = await import('../lib/mailer.js');
const { applyPaymentEvent, eventFromInvoice } = await import('../lib/payments.js');
const { getInvoice } = await import('../lib/btcpay.js');
const { hashPassword } = await import('../lib/session.js');
const { Visitor } = await import('../test/visitor.js');

type App = Awaited<ReturnType<typeof buildServer>>;
const RUN = randomBytes(4).toString('hex');
const SLUG = `pay-probe-${RUN}`;
const LAST = `pay-last-${RUN}`;
const CODE = `PAY10-${RUN}`.toUpperCase();
const ADMIN = `pay-admin-${RUN}@example.com`;
const ADMIN_PW = 'correct horse battery staple 8008';
const CUSTOMER = { name: `Pay Probe ${RUN}`, line1: '5 Ledger Lane', city: 'Satoshiville', postcode: 'BT1 1CN', country: 'Probeland' };

let app: App;
let v: InstanceType<typeof Visitor>;
const sent: { to: string; subject: string; text: string }[] = [];
let mailFails = 0;
const emails: string[] = [];

before(async () => {
  setTransport({ send: async (m) => { if (mailFails > 0) { mailFails -= 1; throw new Error('smtp down'); } sent.push(m); } });
  app = await buildServer();
  await app.ready();
  const db = getDb();
  await db.insertInto('products').values({ slug: SLUG, name: 'Pay Probe Item', price_cents: 2500, stock: 20, active: true }).execute();
  await db.insertInto('products').values({ slug: LAST, name: 'Pay Probe Last', price_cents: 1000, stock: 1, active: true }).execute();
  await db.insertInto('promotions').values({ code: CODE, type: 'percent', value: 10 }).execute();
  await db.insertInto('admin_users').values({ email: ADMIN, password_hash: await hashPassword(ADMIN_PW), totp_secret: null }).execute();
});

after(async () => {
  const db = getDb();
  if (emails.length > 0) await db.deleteFrom('orders').where('email_bidx', 'in', emails.map((e) => blindIndex(e, 'orders.email'))).execute();
  await db.deleteFrom('products').where('slug', 'in', [SLUG, LAST]).execute();
  await db.deleteFrom('promotions').where('code', '=', CODE).execute();
  await db.deleteFrom('audit_log').where('actor', '=', ADMIN).execute();
  await db.deleteFrom('admin_users').where('email', '=', ADMIN).execute();
  await app.close();
  await closeDb();
  fake.close();
});

beforeEach(() => {
  v = new Visitor(app, `/p/${SLUG}`);
  btcpayDown = false;
});

async function checkout(opts: { slug?: string; qty?: number; code?: string } = {}) {
  const email = `pay.${RUN}.${emails.length}@example.com`;
  emails.push(email);
  await v.add(opts.slug ?? SLUG, opts.qty);
  if (opts.code) await v.applyCode(opts.code);
  const page = await v.get('/checkout');
  const field = (n: string) => new RegExp(`name="${n}" value="([^"]+)"`).exec(page.body)?.[1] ?? '';
  const res = await v.post('/checkout', { ...CUSTOMER, email, _csrf: field('_csrf'), token: field('token'), expectedTotal: field('expectedTotal') });
  const order = await getDb().selectFrom('orders').selectAll().where('checkout_token', '=', field('token')).executeTakeFirstOrThrow();
  const pay = await getDb().selectFrom('payments').selectAll().where('order_id', '=', order.id).orderBy('created_at', 'desc').executeTakeFirst();
  return { res, order, pay, email };
}

let delivery = 0;
async function webhook(type: string, invoiceId: string, extra: object = {}, opts: { sig?: string; deliveryId?: string } = {}) {
  const body = JSON.stringify({ deliveryId: opts.deliveryId ?? `d_${RUN}_${delivery++}`, webhookId: 'wh', type, invoiceId, storeId: STORE, timestamp: 0, ...extra });
  const sig = opts.sig ?? `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  return app.inject({ method: 'POST', url: '/webhooks/btcpay', headers: { 'content-type': 'application/json', 'btcpay-sig': sig }, payload: body });
}
const orderRow = (id: string) => getDb().selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const stockOf = async (slug: string) => (await getDb().selectFrom('products').select('stock').where('slug', '=', slug).executeTakeFirstOrThrow()).stock;
const flush = () => processOutbox(getDb(), 50);

// --- checkout to invoice --------------------------------------------------------

test('placing an order goes straight to a BTCPay invoice for the exact total', async () => {
  const { res, order, pay } = await checkout();
  assert.ok(pay);
  assert.equal(res.headers['location'], `https://pay.example/i/${pay.btcpay_invoice_id}`);
  assert.equal(pay.status, 'new');
  assert.equal(pay.amount_fiat_cents, order.total_cents);
  assert.equal(invoices.get(pay.btcpay_invoice_id)?.amount, (order.total_cents / 100).toFixed(2));
});

test('BTCPay is told only our order id and number, never who the customer is', async () => {
  const before = received.length;
  const { email } = await checkout();
  const bodies = received.slice(before).join('\n');
  for (const secret of [email, CUSTOMER.name, CUSTOMER.line1, CUSTOMER.postcode]) assert.ok(!bodies.includes(secret), secret);
});

test('the order-received email is sent to the customer, with no address in it', async () => {
  const { email, order } = await checkout();
  await flush();
  const mail = sent.find((m) => m.to === email && m.subject.includes('received'));
  assert.ok(mail, 'received email sent');
  assert.match(mail.text, new RegExp(order.order_number));
  assert.ok(!mail.text.includes(CUSTOMER.line1));
  assert.ok(!/<img|https?:\/\/(?!.*\/order)/.test(mail.text.replace(/\S+\/order\b/g, '')), 'no images or outside links');
});

test('paying again reuses the open invoice instead of billing twice', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  const again = await v.post('/checkout/pay', {});
  assert.equal(again.headers['location'], pay.checkout_url);
  const rows = await getDb().selectFrom('payments').select('id').where('order_id', '=', order.id).execute();
  assert.equal(rows.length, 1);
});

test('if BTCPay is down the order is kept and the customer can pay later', async () => {
  btcpayDown = true;
  const { res, order, pay } = await checkout();
  assert.equal(res.headers['location'], '/checkout/done?pay=unavailable');
  assert.equal(pay, undefined);
  assert.equal(order.status, 'pending');
  const page = await v.get('/checkout/done?pay=unavailable');
  assert.match(page.body, /could not be opened just now/);
  assert.match(page.body, /action="\/checkout\/pay"/);
  btcpayDown = false;
  const retry = await v.post('/checkout/pay', {});
  assert.match(String(retry.headers['location']), /^https:\/\/pay\.example\/i\//);
});

// --- the webhook -----------------------------------------------------------------

test('a webhook without a valid signature is refused and changes nothing', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  assert.equal((await webhook('InvoiceSettled', pay.btcpay_invoice_id, {}, { sig: 'sha256=' + '0'.repeat(64) })).statusCode, 401);
  assert.equal((await webhook('InvoiceSettled', pay.btcpay_invoice_id, {}, { sig: '' })).statusCode, 401);
  assert.equal((await orderRow(order.id)).status, 'pending');
});

test('settled: the order is paid, stock is taken, the code use is counted, and the customer is told', async () => {
  const db = getDb();
  const promoBefore = (await db.selectFrom('promotions').select('used_count').where('code', '=', CODE).executeTakeFirstOrThrow()).used_count;
  const stockBefore = await stockOf(SLUG);
  const { order, pay, email } = await checkout({ qty: 2, code: CODE });
  assert.ok(pay);
  const res = await webhook('InvoiceSettled', pay.btcpay_invoice_id);
  assert.equal(res.json().outcome, 'paid');
  const o = await orderRow(order.id);
  assert.equal(o.status, 'paid');
  assert.ok(o.paid_at);
  assert.equal(await stockOf(SLUG), stockBefore - 2);
  assert.equal((await db.selectFrom('promotions').select('used_count').where('code', '=', CODE).executeTakeFirstOrThrow()).used_count, promoBefore + 1);
  await flush();
  assert.ok(sent.some((m) => m.to === email && m.subject.startsWith('Payment confirmed')));
});

test('the same delivery twice, or a redelivery, is applied once', async () => {
  const stockBefore = await stockOf(SLUG);
  const { pay } = await checkout();
  assert.ok(pay);
  const id = `d_${RUN}_dup`;
  assert.equal((await webhook('InvoiceSettled', pay.btcpay_invoice_id, {}, { deliveryId: id })).json().outcome, 'paid');
  assert.equal((await webhook('InvoiceSettled', pay.btcpay_invoice_id, {}, { deliveryId: id })).json().outcome, 'duplicate');
  assert.equal((await webhook('InvoiceSettled', pay.btcpay_invoice_id)).json().outcome, 'repeat');
  assert.equal(await stockOf(SLUG), stockBefore - 1);
});

test('out of order: an expiry arriving after payment changes nothing', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  await webhook('InvoiceSettled', pay.btcpay_invoice_id);
  assert.equal((await webhook('InvoiceExpired', pay.btcpay_invoice_id)).json().outcome, 'repeat');
  assert.equal((await orderRow(order.id)).status, 'paid');
});

test('expired unpaid: the order expires; a late payment still completes it', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  await webhook('InvoiceExpired', pay.btcpay_invoice_id);
  assert.equal((await orderRow(order.id)).status, 'expired');
  await webhook('InvoiceSettled', pay.btcpay_invoice_id);
  assert.equal((await orderRow(order.id)).status, 'paid');
});

test('underpaid: the payment is flagged and the order waits for the admin', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  assert.equal((await webhook('InvoiceExpired', pay.btcpay_invoice_id, { partiallyPaid: true })).json().outcome, 'underpaid');
  assert.equal((await orderRow(order.id)).status, 'pending');
  const p = await getDb().selectFrom('payments').select('status').where('id', '=', pay.id).executeTakeFirstOrThrow();
  assert.equal(p.status, 'underpaid');
});

test('overpaid: the order is paid and the payment is flagged for a partial refund', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  await webhook('InvoiceSettled', pay.btcpay_invoice_id, { overPaid: true });
  assert.equal((await orderRow(order.id)).status, 'paid');
  assert.equal((await getDb().selectFrom('payments').select('status').where('id', '=', pay.id).executeTakeFirstOrThrow()).status, 'overpaid');
});

test('invalid: the payment is marked invalid and the order is untouched', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  await webhook('InvoiceInvalid', pay.btcpay_invoice_id);
  assert.equal((await orderRow(order.id)).status, 'pending');
  assert.equal((await getDb().selectFrom('payments').select('status').where('id', '=', pay.id).executeTakeFirstOrThrow()).status, 'invalid');
});

test('two people pay for the last unit: both orders stand, stock stops at zero, and the admin is told', async () => {
  const db = getDb();
  await db.updateTable('products').set({ stock: 1 }).where('slug', '=', LAST).execute();
  const a = await checkout({ slug: LAST });
  v = new Visitor(app, `/p/${SLUG}`);
  const b = await checkout({ slug: LAST });
  assert.ok(a.pay && b.pay);
  await webhook('InvoiceSettled', a.pay.btcpay_invoice_id);
  await webhook('InvoiceSettled', b.pay.btcpay_invoice_id);
  assert.equal(await stockOf(LAST), 0);
  assert.match((await orderRow(b.order.id)).admin_note ?? '', /Oversold: Pay Probe Last \(needed 1, had 0\)/);
});

test('an unknown invoice is acknowledged and ignored', async () => {
  const res = await webhook('InvoiceSettled', 'inv_not_ours');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().outcome, 'unknown-invoice');
});

// --- guest lookup and reconciliation ------------------------------------------------

test('a guest can pay from the order lookup, with the email in the form body only', async () => {
  btcpayDown = true;
  const { order, email } = await checkout();
  btcpayDown = false;
  const look = new Visitor(app, '/order');
  const found = await look.post('/order', { number: order.order_number, email });
  assert.match(found.body, /action="\/order\/pay"/);
  const pay = await look.post('/order/pay', { number: order.order_number, email });
  assert.match(String(pay.headers['location']), /^https:\/\/pay\.example\/i\//);
});

test('a webhook that never arrived is caught by reconciliation', async () => {
  const { order, pay } = await checkout();
  assert.ok(pay);
  const inv = invoices.get(pay.btcpay_invoice_id);
  assert.ok(inv);
  inv.status = 'Settled';
  const ev = eventFromInvoice(await getInvoice(pay.btcpay_invoice_id));
  assert.ok(ev);
  assert.equal(await applyPaymentEvent(getDb(), ev), 'paid');
  assert.equal((await orderRow(order.id)).status, 'paid');
});

// --- admin -------------------------------------------------------------------------

async function adminVisitor() {
  const admin = new Visitor(app, '/admin/orders');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: ADMIN, password: ADMIN_PW })).headers['location'], '/admin');
  admin.jar = login.jar;
  return admin;
}

test('cancelling an unpaid order voids its invoice at BTCPay; a payment that still arrives is flagged for refund', async () => {
  const admin = await adminVisitor();
  const { order, pay } = await checkout();
  assert.ok(pay);
  await admin.post(`/admin/orders/${order.id}/cancel`, {});
  assert.equal(invoices.get(pay.btcpay_invoice_id)?.status, 'Invalid');
  assert.equal((await webhook('InvoiceSettled', pay.btcpay_invoice_id)).json().outcome, 'paid-after-cancel');
  const o = await orderRow(order.id);
  assert.equal(o.status, 'cancelled');
  assert.match(o.admin_note ?? '', /refund is due/);
  const page = await admin.get(`/admin/orders/${order.id}`);
  assert.match(page.body, /Mark as refunded/);
});

test('shipping emails the customer their tracking number', async () => {
  const admin = await adminVisitor();
  const { order, pay, email } = await checkout();
  assert.ok(pay);
  await webhook('InvoiceSettled', pay.btcpay_invoice_id);
  await admin.post(`/admin/orders/${order.id}/ship`, { tracking: 'TRK-77-PAY' });
  await flush();
  const mail = sent.find((m) => m.to === email && m.subject.includes('shipped'));
  assert.ok(mail);
  assert.match(mail.text, /TRK-77-PAY/);
});

test('the admin sees each invoice, can reopen an expired order, and can resend an email', async () => {
  const admin = await adminVisitor();
  const { order, pay, email } = await checkout();
  assert.ok(pay);
  await webhook('InvoiceExpired', pay.btcpay_invoice_id);
  let page = await admin.get(`/admin/orders/${order.id}`);
  assert.match(page.body, new RegExp(pay.btcpay_invoice_id));
  assert.match(page.body, /Expired unpaid/);
  await admin.post(`/admin/orders/${order.id}/reopen`, {});
  assert.equal((await orderRow(order.id)).status, 'pending');
  const before = sent.filter((m) => m.to === email).length;
  await admin.post(`/admin/orders/${order.id}/resend`, { kind: 'received' });
  await flush();
  assert.equal(sent.filter((m) => m.to === email).length, before + 1);
  page = await admin.get(`/admin/orders/${order.id}`);
  assert.match(page.body, /Received[\s\S]*sent/);
});

// --- email delivery ---------------------------------------------------------------

test('if the mail service fails, the email is retried later rather than lost', async () => {
  mailFails = 1;
  const { order, email } = await checkout();
  await flush();
  const row = await getDb().selectFrom('email_outbox').selectAll().where('order_id', '=', order.id).executeTakeFirstOrThrow();
  assert.equal(row.sent_at, null);
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > new Date());
  await getDb().updateTable('email_outbox').set({ next_attempt_at: new Date() }).where('id', '=', row.id).execute();
  await flush();
  assert.ok(sent.some((m) => m.to === email));
});

