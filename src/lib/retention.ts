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

import type { Transaction } from 'kysely';

import type { Database } from './db.js';

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
    .values({ ...run, error: run.error ?? null })
    .execute();
}
