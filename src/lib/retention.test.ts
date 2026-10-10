/**
 * Retention purge tests against the real database. Own orders and customers,
 * deleted afterwards. Settings are passed in explicitly, so these tests never
 * touch the shared settings table and cannot race the settings-page tests.
 *
 *   npm test
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { blindIndex, encrypt, encryptAddress, initCrypto } from './crypto.js';
import { closeDb, getDb } from './db.js';
import { runPurge } from './retention.js';
import type { StoreSettings } from './settings.js';

const RUN = randomBytes(3).toString('hex').toUpperCase();
const DAY = 86_400_000;
const numbers: string[] = [];
const emails: string[] = [];

const purge = (by: 'schedule' | 'admin', over: Partial<StoreSettings> = {}) =>
  runPurge(getDb(), by, { settings: { retention_days: 30, purge_enabled: true, ...over } });

async function order(status: 'pending' | 'paid' | 'shipped' | 'complete' | 'cancelled' | 'expired', ageDays: number, customerId: string | null = null) {
  const number = `SO-P${RUN.slice(0, 3)}-${String(numbers.length).padStart(4, '0')}`;
  numbers.push(number);
  const email = `purge.${RUN.toLowerCase()}.${numbers.length}@example.com`;
  const row = await getDb()
    .insertInto('orders')
    .values({
      order_number: number, customer_id: customerId, status,
      email_enc: encrypt(email, 'orders.email'), email_bidx: blindIndex(email, 'orders.email'),
      name_enc: encrypt(`Purge Probe ${RUN}`, 'orders.name'),
      address_enc: encryptAddress({ line1: '1 Purge Street', city: 'Purgeton', postcode: 'PG1 1RG', country: 'Probeland' }),
      phone_enc: null, subtotal_cents: 3000, total_cents: 3000, promotion_id: null, checkout_token: null,
      tracking_number: null, admin_note: null, paid_at: null, shipped_at: null, completed_at: null,
      placed_at: new Date(Date.now() - ageDays * DAY),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await getDb()
    .insertInto('order_items')
    .values({ order_id: row.id, product_id: null, name_snapshot: 'Purge Probe Item', unit_price_cents: 1000, quantity: 3, line_total_cents: 3000 })
    .execute();
  return row.id;
}

async function customer(tag: string, lastLoginDaysAgo: number): Promise<string> {
  const email = `purge.${RUN.toLowerCase()}.${tag}@example.com`;
  emails.push(email);
  const row = await getDb()
    .insertInto('customers')
    .values({
      email_enc: encrypt(email, 'customers.email'), email_bidx: blindIndex(email, 'customers.email'),
      name_enc: null, password_hash: '$argon2id$placeholder', locked_until: null,
      last_login_at: new Date(Date.now() - lastLoginDaysAgo * DAY),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const exists = async (table: 'orders' | 'customers', id: string) =>
  (await getDb().selectFrom(table).select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
const aggregates = async () => Number((await getDb().selectFrom('order_aggregates').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

before(() => {
  initCrypto();
});

after(async () => {
  const db = getDb();
  if (numbers.length > 0) await db.deleteFrom('orders').where('order_number', 'in', numbers).execute();
  if (emails.length > 0) await db.deleteFrom('customers').where('email_bidx', 'in', emails.map((e) => blindIndex(e, 'customers.email'))).execute();
  await closeDb();
});

test('only finished orders older than the retention window are purged', async () => {
  const oldComplete = await order('complete', 45);
  const oldCancelled = await order('cancelled', 45);
  const oldExpired = await order('expired', 45);
  const oldPaidStillToShip = await order('paid', 45);
  const oldShipped = await order('shipped', 45);
  const oldPending = await order('pending', 45);
  const recentComplete = await order('complete', 5);
  const before = await aggregates();

  const run = await purge('schedule');

  assert.equal(run.error, undefined);
  assert.ok(run.orders_purged >= 3);
  for (const id of [oldComplete, oldCancelled, oldExpired]) assert.equal(await exists('orders', id), false, 'finished and old: gone');
  for (const id of [oldPaidStillToShip, oldShipped, oldPending]) assert.equal(await exists('orders', id), true, 'in flight: kept, however old');
  assert.equal(await exists('orders', recentComplete), true, 'finished but recent: kept');
  assert.ok((await aggregates()) >= before + 3, 'each purged order leaves one anonymous aggregate');
});

test('the aggregate carries the sale, and nothing personal', async () => {
  const db = getDb();
  const id = await order('complete', 60);
  const before = await aggregates();
  await purge('schedule');
  assert.equal(await exists('orders', id), false);
  assert.ok((await aggregates()) > before);
  const latest = await db
    .selectFrom('order_aggregates')
    .selectAll()
    .where('total_cents', '=', 3000)
    .where('item_count', '=', 3)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  assert.equal(latest.was_paid, true);
  const columns = Object.keys(latest);
  for (const forbidden of ['email', 'name', 'address', 'order_number']) assert.ok(!columns.some((c) => c.includes(forbidden)), forbidden);
});

test('a cancelled order counts as not paid', async () => {
  const db = getDb();
  const id = await order('cancelled', 60);
  const placed = (await db.selectFrom('orders').select('placed_at').where('id', '=', id).executeTakeFirstOrThrow()).placed_at;
  await purge('schedule');
  const agg = await db
    .selectFrom('order_aggregates')
    .select('was_paid')
    .where('order_date', '=', placed)
    .where('total_cents', '=', 3000)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  assert.equal(agg.was_paid, false);
});

test('inactive accounts with no live orders are removed; active ones and ones with live orders stay', async () => {
  const dormant = await customer('dormant', 90);
  const active = await customer('active', 2);
  const dormantWithLiveOrder = await customer('live', 90);
  await order('paid', 90, dormantWithLiveOrder);

  const run = await purge('schedule');

  assert.equal(await exists('customers', dormant), false);
  assert.equal(await exists('customers', active), true);
  assert.equal(await exists('customers', dormantWithLiveOrder), true);
  assert.ok(run.customers_purged >= 1);
});

test('running it again finds nothing more, and every run is recorded', async () => {
  const db = getDb();
  const id = await order('complete', 50);
  await purge('schedule');
  assert.equal(await exists('orders', id), false);
  const runsBefore = Number((await db.selectFrom('purge_runs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
  const again = await purge('schedule');
  assert.equal(again.error, undefined);
  const runsAfter = Number((await db.selectFrom('purge_runs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
  assert.equal(runsAfter, runsBefore + 1);
  const latest = await db.selectFrom('purge_runs').select(['triggered_by', 'retention_days']).orderBy('ran_at', 'desc').limit(1).executeTakeFirstOrThrow();
  assert.equal(latest.triggered_by, 'schedule');
  assert.equal(latest.retention_days, 30);
});

test('the retention window decides what is old enough', async () => {
  const id = await order('complete', 10);
  await purge('schedule', { retention_days: 30 });
  assert.equal(await exists('orders', id), true, '10 days old, 30-day window: kept');
  await purge('schedule', { retention_days: 7 });
  assert.equal(await exists('orders', id), false, '10 days old, 7-day window: gone');
});

test('with automatic deletion switched off, nothing is deleted and the run says so', async () => {
  const id = await order('complete', 60);
  const run = await purge('schedule', { purge_enabled: false });
  assert.equal(run.skipped, true);
  assert.equal(run.orders_purged, 0);
  assert.equal(await exists('orders', id), true);
});

test('an admin-triggered run ignores the schedule switch', async () => {
  const id = await order('complete', 60);
  const run = await purge('admin', { purge_enabled: false });
  assert.equal(run.skipped, undefined);
  assert.equal(await exists('orders', id), false);
});

test('shipped orders become complete after the set days, then follow the retention clock', async () => {
  const db = getDb();
  const old = await order('shipped', 60);
  const recent = await order('shipped', 60);
  await db.updateTable('orders').set({ shipped_at: new Date(Date.now() - 20 * DAY) }).where('id', '=', old).execute();
  await db.updateTable('orders').set({ shipped_at: new Date(Date.now() - 3 * DAY) }).where('id', '=', recent).execute();

  const run = await purge('admin', { complete_after_days: 14, export_before_purge: false });
  assert.ok((run.orders_completed ?? 0) >= 1);

  const st = async (id: string) => (await db.selectFrom('orders').select(['status', 'completed_at']).where('id', '=', id).executeTakeFirstOrThrow());
  const o = await st(old);
  assert.equal(o.status, 'complete');
  assert.ok(o.completed_at !== null);
  assert.equal((await st(recent)).status, 'shipped', 'shipped 3 days ago: still in the post');

  // Placed 60 days ago but only just completed: the 30-day clock starts now,
  // so the details are kept for the return window rather than wiped at once.
  assert.ok(await exists('orders', old), 'a just-completed order keeps its details for the retention period');

  await db.updateTable('orders').set({ completed_at: new Date(Date.now() - 31 * DAY) }).where('id', '=', old).execute();
  await purge('admin', { export_before_purge: false });
  assert.equal(await exists('orders', old), false, 'completed 31 days ago with a 30-day window: wiped');
});

test('completing shipped orders happens even when scheduled deletion is off', async () => {
  const db = getDb();
  const id = await order('shipped', 40);
  await db.updateTable('orders').set({ shipped_at: new Date(Date.now() - 30 * DAY) }).where('id', '=', id).execute();
  const run = await purge('schedule', { purge_enabled: false, complete_after_days: 14 });
  assert.equal(run.skipped, true);
  assert.equal((await db.selectFrom('orders').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status, 'complete');
  assert.ok(await exists('orders', id), 'nothing deleted while deletion is off');
});
