/**
 * Orders and their Bitcoin invoices.
 *
 * `ensureInvoice` gives a pending order a payable invoice, reusing a live one
 * rather than creating a second bill for the same order.
 *
 * `applyPaymentEvent` is the only place an order's payment state changes. The
 * webhook and the reconciliation job both call it, so a missed webhook that
 * reconciliation catches later has exactly the same effect. It runs in one
 * transaction with the order locked, and every transition checks the state it
 * starts from, so events can arrive twice, late or out of order:
 *
 *   settled  pending/expired -> paid; stock taken; discount use counted
 *            already paid      -> nothing (repeat)
 *            cancelled         -> stays cancelled; flagged for a refund
 *   expired  pending -> expired, unless another invoice for it is still live
 *            partly paid      -> payment marked underpaid; order left for the admin
 *   invalid  payment marked invalid; order untouched
 *   processing / received  payment marked processing; order still pending
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { type Invoice, createInvoice } from './btcpay.js';
import { loadConfig } from './config.js';
import type { Database } from './db.js';
import { emitOrderEvent } from './order-events.js';

export type PaymentEventType = 'settled' | 'expired' | 'invalid' | 'processing';

export interface PaymentEvent {
  invoiceId: string;
  type: PaymentEventType;
  overPaid?: boolean;
  partiallyPaid?: boolean;
}

/** BTCPay webhook type -> our event, or null for types we do not act on. */
export function eventFromWebhook(type: string): PaymentEventType | null {
  switch (type) {
    case 'InvoiceSettled':
      return 'settled';
    case 'InvoiceExpired':
      return 'expired';
    case 'InvoiceInvalid':
      return 'invalid';
    case 'InvoiceProcessing':
    case 'InvoiceReceivedPayment':
    case 'InvoicePaymentSettled':
      return 'processing';
    default:
      return null;
  }
}

/** BTCPay invoice status -> our event, for reconciliation. */
export function eventFromInvoice(inv: Invoice): PaymentEvent | null {
  const base = { invoiceId: inv.id };
  switch (inv.status) {
    case 'Settled':
      return { ...base, type: 'settled', overPaid: inv.additionalStatus === 'PaidOver' };
    case 'Expired':
      return { ...base, type: 'expired', partiallyPaid: inv.additionalStatus === 'PaidPartial' };
    case 'Invalid':
      return { ...base, type: 'invalid' };
    case 'Processing':
      return { ...base, type: 'processing' };
    default:
      return null;
  }
}

const LIVE = ['new', 'processing'] as const;

export async function ensureInvoice(
  db: Kysely<Database>,
  orderId: string,
  returnPath: string,
): Promise<string | null> {
  const order = await db
    .selectFrom('orders')
    .select(['id', 'order_number', 'status', 'total_cents', 'currency'])
    .where('id', '=', orderId)
    .executeTakeFirst();
  if (order === undefined || order.status !== 'pending') return null;

  const live = await db
    .selectFrom('payments')
    .select(['checkout_url'])
    .where('order_id', '=', orderId)
    .where('status', 'in', [...LIVE])
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date(Date.now() + 60_000))]))
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (live?.checkout_url) return live.checkout_url;

  const inv = await createInvoice({
    amountCents: order.total_cents,
    currency: order.currency,
    orderId: order.id,
    orderNumber: order.order_number,
    redirectUrl: `${loadConfig().PUBLIC_URL.replace(/\/+$/, '')}${returnPath}`,
  });
  await db
    .insertInto('payments')
    .values({
      order_id: order.id,
      btcpay_invoice_id: inv.id,
      status: 'new',
      amount_fiat_cents: order.total_cents,
      currency_fiat: order.currency,
      amount_crypto: null,
      currency_crypto: null,
      exchange_rate: null,
      checkout_url: inv.checkoutLink,
      settled_at: null,
      expires_at: new Date(inv.expirationTime * 1000),
    })
    .onConflict((oc) => oc.column('btcpay_invoice_id').doNothing())
    .execute();
  return inv.checkoutLink;
}

type PaymentStatus = 'new' | 'processing' | 'settled' | 'expired' | 'invalid' | 'underpaid' | 'overpaid';

export type Outcome = 'paid' | 'repeat' | 'paid-after-cancel' | 'expired' | 'underpaid' | 'invalid' | 'processing' | 'unknown-invoice' | 'ignored';

export async function applyPaymentEvent(db: Kysely<Database>, ev: PaymentEvent): Promise<Outcome> {
  let orderId: string | null = null;
  const result = await db.transaction().execute(async (trx) => {
    const payment = await trx
      .selectFrom('payments')
      .select(['id', 'order_id', 'status'])
      .where('btcpay_invoice_id', '=', ev.invoiceId)
      .forUpdate()
      .executeTakeFirst();
    if (payment === undefined) return 'unknown-invoice' as const;

    const order = await trx
      .selectFrom('orders')
      .select(['id', 'status', 'promotion_id', 'admin_note'])
      .where('id', '=', payment.order_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    orderId = order.id;
    const now = new Date();
    const setPayment = (status: PaymentStatus, extra: { settled_at?: Date } = {}) =>
      trx.updateTable('payments').set({ status, updated_at: now, ...extra }).where('id', '=', payment.id).execute();

    switch (ev.type) {
      case 'processing': {
        if (payment.status === 'new') await setPayment('processing');
        return 'processing' as const;
      }
      case 'invalid': {
        if (payment.status !== 'settled' && payment.status !== 'overpaid') await setPayment('invalid');
        return 'invalid' as const;
      }
      case 'expired': {
        if (payment.status === 'settled' || payment.status === 'overpaid') return 'repeat' as const;
        if (ev.partiallyPaid) {
          await setPayment('underpaid');
          return 'underpaid' as const;
        }
        await setPayment('expired');
        if (order.status === 'pending') {
          const other = await trx
            .selectFrom('payments')
            .select('id')
            .where('order_id', '=', order.id)
            .where('id', '!=', payment.id)
            .where('status', 'in', ['new', 'processing', 'settled', 'overpaid', 'underpaid'])
            .executeTakeFirst();
          if (other === undefined) await trx.updateTable('orders').set({ status: 'expired', updated_at: now }).where('id', '=', order.id).execute();
        }
        return 'expired' as const;
      }
      case 'settled': {
        const alreadySettled = payment.status === 'settled' || payment.status === 'overpaid';
        if (!alreadySettled) await setPayment(ev.overPaid ? 'overpaid' : 'settled', { settled_at: now });

        if (order.status === 'cancelled' || order.status === 'refunded') {
          if (!alreadySettled) {
            await trx
              .updateTable('orders')
              .set({ admin_note: appendNote(order.admin_note, 'Payment arrived after this order was cancelled: a refund is due.'), updated_at: now })
              .where('id', '=', order.id)
              .execute();
          }
          return 'paid-after-cancel' as const;
        }
        if (order.status !== 'pending' && order.status !== 'expired') return 'repeat' as const;

        await trx.updateTable('orders').set({ status: 'paid', paid_at: now, updated_at: now }).where('id', '=', order.id).execute();

        // Take stock. Never below zero; if two people paid for the last unit, say so.
        const items = await trx
          .selectFrom('order_items')
          .innerJoin('products', 'products.id', 'order_items.product_id')
          .select(['products.id as pid', 'products.name as name', 'products.stock as stock', 'products.track_stock as track', 'order_items.quantity as qty'])
          .where('order_items.order_id', '=', order.id)
          .forUpdate()
          .execute();
        const short: string[] = [];
        for (const i of items) {
          if (!i.track) continue;
          if (i.stock < i.qty) short.push(`${i.name} (needed ${i.qty}, had ${i.stock})`);
          await trx
            .updateTable('products')
            .set({ stock: sql<number>`greatest(stock - ${i.qty}, 0)`, updated_at: now })
            .where('id', '=', i.pid)
            .execute();
        }
        if (short.length > 0) {
          await trx
            .updateTable('orders')
            .set({ admin_note: appendNote(order.admin_note, `Oversold: ${short.join('; ')}.`) })
            .where('id', '=', order.id)
            .execute();
        }
        if (order.promotion_id !== null) {
          await trx
            .updateTable('promotions')
            .set({ used_count: sql<number>`used_count + 1` })
            .where('id', '=', order.promotion_id)
            .execute();
        }
        return 'paid' as const;
      }
    }
  });
  if (result === 'paid' && orderId !== null) await emitOrderEvent(db, orderId, 'paid');
  return result;
}

function appendNote(existing: string | null, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}

