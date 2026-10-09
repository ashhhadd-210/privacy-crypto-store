/**
 * Order emails: the outbox sender and the three templates.
 *
 * Plain text only. No images, no tracking pixels, no links except the store's
 * own order page. The recipient is decrypted at send time and never stored
 * anywhere else; logs carry the outbox id and the kind, never an address.
 *
 * The transport is pluggable: SMTP in production (nodemailer, loaded only
 * when SMTP_HOST is set), a recording transport in tests, and a no-op that
 * leaves rows queued when nothing is configured, so nothing is lost before the
 * mail provider exists.
 */

import type { Kysely } from 'kysely';

import { decrypt } from './crypto.js';
import type { Database } from './db.js';
import { formatMoney } from './money.js';
import { getSettings } from './settings.js';

export type EmailKind = 'received' | 'paid' | 'shipped';

export interface Message {
  to: string;
  subject: string;
  text: string;
}

export interface Transport {
  send(msg: Message): Promise<void>;
}

const MAX_ATTEMPTS = 8;

let transport: Transport | null | undefined;

/** Tests install a recording transport; production builds SMTP from the environment. */
export function setTransport(t: Transport | null): void {
  transport = t;
}

async function getTransport(): Promise<Transport | null> {
  if (transport !== undefined) return transport;
  const host = process.env['SMTP_HOST'];
  if (!host) return (transport = null);
  const modName: string = 'nodemailer';
  type Mod = { createTransport: (o: object) => { sendMail: (m: object) => Promise<unknown> } };
  const mod = (await import(modName)) as Mod & { default?: Mod };
  const nodemailer = mod.default ?? mod;
  const smtp = nodemailer.createTransport({
    host,
    port: Number(process.env['SMTP_PORT'] ?? 587),
    secure: Number(process.env['SMTP_PORT'] ?? 587) === 465,
    requireTLS: true,
    auth: { user: process.env['SMTP_USER'], pass: process.env['SMTP_PASS'] },
  });
  const from = process.env['MAIL_FROM'] ?? 'orders@example.invalid';
  return (transport = { send: async (m) => void (await smtp.sendMail({ from, ...m })) });
}

export async function render(db: Kysely<Database>, orderId: string, kind: EmailKind): Promise<Message | null> {
  const o = await db
    .selectFrom('orders')
    .select(['order_number', 'email_enc', 'total_cents', 'subtotal_cents', 'discount_cents', 'shipping_cents', 'tracking_number'])
    .where('id', '=', orderId)
    .executeTakeFirst();
  if (o === undefined) return null;
  const items = await db
    .selectFrom('order_items')
    .select(['name_snapshot', 'quantity', 'line_total_cents'])
    .where('order_id', '=', orderId)
    .execute();
  const s = await getSettings(db);
  const store = s.store_name || 'the store';
  const base = (process.env['PUBLIC_URL'] ?? '').replace(/\/+$/, '');

  const lines = items.map((i) => `  ${i.quantity} x ${i.name_snapshot}  ${formatMoney(i.line_total_cents)}`).join('\n');
  const totals = [
    `  Subtotal  ${formatMoney(o.subtotal_cents)}`,
    ...(o.discount_cents > 0 ? [`  Discount  -${formatMoney(o.discount_cents)}`] : []),
    `  Shipping  ${formatMoney(o.shipping_cents)}`,
    `  Total     ${formatMoney(o.total_cents)}`,
  ].join('\n');
  const footer =
    `Check your order any time at ${base}/order with your order number and this email address.\n\n` +
    `Your details are encrypted and deleted automatically after ${s.retention_days} days.\n${store}`;

  const intro: Record<EmailKind, [string, string]> = {
    received: [
      `Order ${o.order_number} received`,
      `Thank you. We have your order ${o.order_number}.\nIt will be prepared once your Bitcoin payment is confirmed.`,
    ],
    paid: [`Payment confirmed for order ${o.order_number}`, `Your payment for order ${o.order_number} is confirmed. We are preparing it now.`],
    shipped: [
      `Order ${o.order_number} has shipped`,
      `Your order ${o.order_number} is on its way.` + (o.tracking_number ? `\nTracking number: ${o.tracking_number}` : ''),
    ],
  };
  const [subject, opening] = intro[kind];
  return { to: decrypt(o.email_enc, 'orders.email'), subject, text: `${opening}\n\n${lines}\n\n${totals}\n\n${footer}\n` };
}

export async function enqueueEmail(db: Kysely<Database>, orderId: string, kind: EmailKind): Promise<void> {
  await db.insertInto('email_outbox').values({ order_id: orderId, kind }).execute();
}

/** Sends what is due. Called after each enqueue and by a timer; safe to run concurrently. */
export async function processOutbox(db: Kysely<Database>, limit = 20): Promise<{ sent: number; failed: number; waiting: number }> {
  const t = await getTransport();
  if (t === null) return { sent: 0, failed: 0, waiting: 0 };
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('email_outbox')
        .select(['id', 'order_id', 'kind', 'attempts'])
        .where('sent_at', 'is', null)
        .where('next_attempt_at', '<=', new Date())
        .where('attempts', '<', MAX_ATTEMPTS)
        .orderBy('created_at')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return null;
      try {
        const msg = await render(trx as unknown as Kysely<Database>, row.order_id, row.kind as EmailKind);
        if (msg !== null) await t.send(msg);
        await trx.updateTable('email_outbox').set({ sent_at: new Date(), attempts: row.attempts + 1, last_error: null }).where('id', '=', row.id).execute();
        return 'sent' as const;
      } catch (err) {
        const attempts = row.attempts + 1;
        // 1, 2, 4, 8... minutes, capped at four hours.
        const delay = Math.min(2 ** (attempts - 1), 240) * 60_000;
        await trx
          .updateTable('email_outbox')
          .set({ attempts, last_error: (err as Error).message.slice(0, 300), next_attempt_at: new Date(Date.now() + delay) })
          .where('id', '=', row.id)
          .execute();
        return 'failed' as const;
      }
    });
    if (claimed === null) break;
    if (claimed === 'sent') sent += 1;
    else failed += 1;
  }
  const waiting = Number(
    (await db.selectFrom('email_outbox').select((eb) => eb.fn.countAll<number>().as('n')).where('sent_at', 'is', null).executeTakeFirstOrThrow()).n,
  );
  return { sent, failed, waiting };
}
