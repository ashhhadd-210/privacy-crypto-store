/**
 * Things that happen to an order and should reach the customer by email.
 * Queues the email and nudges the sender without making the caller wait on
 * the mail provider: a slow or broken SMTP server must never slow a checkout
 * or fail a payment webhook.
 */

import type { Kysely } from 'kysely';

import type { Database } from './db.js';
import { type EmailKind, enqueueEmail, processOutbox } from './mailer.js';

export async function emitOrderEvent(db: Kysely<Database>, orderId: string, kind: EmailKind): Promise<void> {
  await enqueueEmail(db, orderId, kind);
  void processOutbox(db).catch(() => undefined);
}
