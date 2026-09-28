/**
 * Customer accounts: optional, and holding as little as possible.
 *
 * An account is an encrypted email, a password hash, and nothing else. No
 * address (typed at each checkout), no name. The email is looked up through
 * its blind index, so the database never compares or stores it in the clear.
 *
 * Sessions follow the admin design in session.ts: the cookie holds the token,
 * the database holds only its SHA-256, so a copied database cannot be replayed.
 * The same lockout applies: five failures lock the account for a growing
 * interval, whatever addresses the attempts come from.
 *
 * Registering an email that already has an account gives exactly the same
 * response as a new one. The form is not a way to find out who shops here.
 */

import { randomBytes } from 'node:crypto';

import { blindIndex, decrypt, encrypt } from './crypto.js';
import { getDb } from './db.js';
import { hashPassword, tokenToId, verifyAgainstDummy, verifyPassword } from './session.js';

export const CUSTOMER_COOKIE = 'customer_session';
const SESSION_TTL_DAYS = 30;
const MAX_FAILED_LOGINS = 5;
export const MIN_PASSWORD = 12;

export interface Customer {
  id: string;
  email: string;
}

/** Creates the account, or silently does nothing if the email already has one. */
export async function registerCustomer(email: string, password: string): Promise<void> {
  const db = getDb();
  const password_hash = await hashPassword(password);
  await db
    .insertInto('customers')
    .values({
      email_enc: encrypt(email.trim(), 'customers.email'),
      email_bidx: blindIndex(email, 'customers.email'),
      name_enc: null,
      password_hash,
      last_login_at: null,
      locked_until: null,
    })
    .onConflict((oc) => oc.column('email_bidx').doNothing())
    .execute();
}

export type CustomerLoginResult =
  | { ok: true; customer: Customer }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked' };

export async function verifyCustomerLogin(email: string, password: string): Promise<CustomerLoginResult> {
  const db = getDb();
  const row = await db
    .selectFrom('customers')
    .select(['id', 'email_enc', 'password_hash', 'failed_logins', 'locked_until'])
    .where('email_bidx', '=', blindIndex(email, 'customers.email'))
    .executeTakeFirst();

  if (row === undefined) {
    await verifyAgainstDummy(password);
    return { ok: false, reason: 'invalid' };
  }
  if (row.locked_until !== null && row.locked_until > new Date()) return { ok: false, reason: 'locked' };

  if (!(await verifyPassword(row.password_hash, password))) {
    const failures = row.failed_logins + 1;
    const lockFor = failures >= MAX_FAILED_LOGINS ? 15 * 2 ** (failures - MAX_FAILED_LOGINS) : 0;
    await db
      .updateTable('customers')
      .set({ failed_logins: failures, locked_until: lockFor > 0 ? new Date(Date.now() + lockFor * 60_000) : null })
      .where('id', '=', row.id)
      .execute();
    return { ok: false, reason: 'invalid' };
  }

  await db
    .updateTable('customers')
    .set({ failed_logins: 0, locked_until: null, last_login_at: new Date() })
    .where('id', '=', row.id)
    .execute();
  return { ok: true, customer: { id: row.id, email: decrypt(row.email_enc, 'customers.email') } };
}

export async function createCustomerSession(customerId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await getDb()
    .insertInto('customer_sessions')
    .values({ id: tokenToId(token), customer_id: customerId, expires_at: expiresAt })
    .execute();
  return { token, expiresAt };
}

export async function resolveCustomer(token: string | undefined): Promise<Customer | null> {
  if (token === undefined || token === '') return null;
  const db = getDb();
  const row = await db
    .selectFrom('customer_sessions')
    .innerJoin('customers', 'customers.id', 'customer_sessions.customer_id')
    .select(['customers.id as id', 'customers.email_enc as email_enc', 'customer_sessions.expires_at as expires_at'])
    .where('customer_sessions.id', '=', tokenToId(token))
    .executeTakeFirst();
  if (row === undefined) return null;
  if (row.expires_at <= new Date()) {
    await destroyCustomerSession(token);
    return null;
  }
  return { id: row.id, email: decrypt(row.email_enc, 'customers.email') };
}

export async function destroyCustomerSession(token: string | undefined): Promise<void> {
  if (token === undefined || token === '') return;
  await getDb().deleteFrom('customer_sessions').where('id', '=', tokenToId(token)).execute();
}

export async function customerPasswordIs(customerId: string, password: string): Promise<boolean> {
  const row = await getDb().selectFrom('customers').select('password_hash').where('id', '=', customerId).executeTakeFirst();
  if (row === undefined) return false;
  return verifyPassword(row.password_hash, password);
}
