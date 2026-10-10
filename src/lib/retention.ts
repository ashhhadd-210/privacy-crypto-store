/**
 * Removing an order's personal data: the one routine for it.
 *
 * Used by account self-delete today and by the scheduled purge. The anonymous
 * aggregate row is written first, then the order goes (payments and items
 * cascade), all in the caller's transaction, so a crash can never leave an
 * order half-erased or a sale uncounted.
 *
 * Only orders in a final state are ever wiped: an order that is still being
 * paid for, or is in the post, keeps its delivery details until it is done.
 */

import { type Kysely, type Transaction, sql } from 'kysely';

import type { Database } from './db.js';
import { loadConfig } from './config.js';
import { type StoreSettings, getSettings } from './settings.js';

export const FINAL_STATES = ['complete', 'cancelled', 'expired', 'refunded'] as const;
const PAID_STATES = new Set(['paid', 'shipped', 'complete']);

export async function wipeOrder(trx: Transaction<Database>, orderId: string): Promise<boolean> {
  const o = await trx
    .selectFrom('orders')
    .select(['id', 'placed_at', 'total_cents', 'currency', 'status'])
    .where('id', '=', orderId)
    .where('status', 'in', [...FINAL_STATES])
    .forUpdate()
    .executeTakeFirst();
  if (o === undefined) return false;

  const items = await trx
    .selectFrom('order_items')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('quantity'), eb.lit(0)).as('n'))
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();

  await trx
    .insertInto('order_aggregates')
    .values({
      order_date: o.placed_at,
      total_cents: o.total_cents,
      item_count: Number(items.n),
      currency: o.currency,
      was_paid: PAID_STATES.has(o.status),
    })
    .execute();

  await trx.deleteFrom('orders').where('id', '=', orderId).execute();
  return true;
}

export interface PurgeRunSummary {
  retention_days: number;
  cutoff_at: Date;
  orders_purged: number;
  customers_purged: number;
  webhooks_purged: number;
  triggered_by: 'schedule' | 'admin' | 'account-delete';
  error?: string;
}

export async function recordPurgeRun(trx: Transaction<Database>, run: PurgeRunSummary): Promise<void> {
  await trx
    .insertInto('purge_runs')
    .values({
      retention_days: run.retention_days,
      cutoff_at: run.cutoff_at,
      orders_purged: run.orders_purged,
      customers_purged: run.customers_purged,
      webhooks_purged: run.webhooks_purged,
      triggered_by: run.triggered_by,
      error: run.error ?? null,
    })
    .execute();
}

export interface PurgeResult extends PurgeRunSummary {
  /** Automatic deletion is switched off in settings; nothing was deleted. */
  skipped?: true;
  /** Shipped orders moved to complete on this run (not stored in purge_runs). */
  orders_completed?: number;
}

/**
 * Shipped orders become complete a set number of days after shipping. Without
 * this step a delivered order would never reach a final state, and so would
 * keep its customer's details for ever. Runs before the purge, whether or not
 * deletion is switched on: it is an order status, not a deletion.
 */
export async function completeShippedOrders(db: Kysely<Database>, days: number): Promise<number> {
  const before = new Date(Date.now() - days * 86_400_000);
  const now = new Date();
  const res = await db
    .updateTable('orders')
    .set({ status: 'complete', completed_at: now, updated_at: now })
    .where('status', '=', 'shipped')
    .where('shipped_at', '<', before)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/**
 * The scheduled purge. Finished orders older than the retention window lose
 * their personal data (one transaction each, so one failure never blocks the
 * rest); webhook payloads older than the window go; accounts with no sign-in
 * inside the window and no order still in flight go. Every run is recorded.
 * The settings switch applies to the schedule only: an admin pressing the
 * button means it.
 */
export async function runPurge(
  db: Kysely<Database>,
  triggeredBy: 'schedule' | 'admin',
  opts: { settings?: Partial<StoreSettings> } = {},
): Promise<PurgeResult> {
  const settings = { ...(await getSettings(db)), ...opts.settings };
  const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000);
  const result: PurgeResult = {
    retention_days: settings.retention_days,
    cutoff_at: cutoff,
    orders_purged: 0,
    customers_purged: 0,
    webhooks_purged: 0,
    triggered_by: triggeredBy,
  };

  result.orders_completed = await completeShippedOrders(db, settings.complete_after_days);

  if (triggeredBy === 'schedule' && !settings.purge_enabled) {
    result.skipped = true;
    await db.transaction().execute((trx) => recordPurgeRun(trx, result));
    return result;
  }

  try {
    // "Export before deleting": only once the client has a key to export to;
    // without one the setting cannot be satisfied and retention still wins.
    const mustExport = settings.export_before_purge && Boolean(loadConfig().EXPORT_AGE_RECIPIENT);
    const due = await db
      .selectFrom('orders')
      .select('id')
      .where('status', 'in', [...FINAL_STATES])
      // The clock starts when the order was finished: delivered orders from
      // completion, everything else from when it was placed.
      .where(sql<Date>`coalesce(completed_at, placed_at)`, '<', cutoff)
      .$if(mustExport, (q) => q.where('exported_at', 'is not', null))
      .execute();
    for (const o of due) {
      const wiped = await db.transaction().execute((trx) => wipeOrder(trx, o.id));
      if (wiped) result.orders_purged += 1;
    }

    const webhooks = await db.deleteFrom('payment_webhooks').where('created_at', '<', cutoff).executeTakeFirst();
    result.webhooks_purged = Number(webhooks.numDeletedRows ?? 0);

    const customers = await db
      .deleteFrom('customers')
      .where((eb) => eb.fn.coalesce('last_login_at', 'created_at'), '<', cutoff)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('orders')
              .select('orders.id')
              .whereRef('orders.customer_id', '=', 'customers.id')
              .where('orders.status', 'not in', [...FINAL_STATES]),
          ),
        ),
      )
      .executeTakeFirst();
    result.customers_purged = Number(customers.numDeletedRows ?? 0);
  } catch (err) {
    result.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
  }

  await db.transaction().execute((trx) => recordPurgeRun(trx, result));
  return result;
}
