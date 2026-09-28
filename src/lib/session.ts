/**
 * Admin authentication and sessions.
 *
 * The admin panel is the crown jewel: it can read every order, change prices,
 * and trigger the retention purge. Everything here is written on the assumption
 * that someone will eventually try the front door with a password list.
 *
 * DESIGN NOTES
 *
 * 1. Passwords are argon2id, the current recommendation for password hashing.
 *    Parameters below are tuned for this VPS, not copied from a blog post.
 *
 * 2. The session cookie holds 32 random bytes. The database stores only the
 *    SHA-256 of that value. This deviates from the comment in 001_init.sql
 *    ("opaque random id, also the cookie value") and 002 updates that comment
 *    to match. The reason: if the database leaks, raw session ids would let the
 *    thief walk straight into the admin panel as the client. Storing the hash
 *    means a leaked database contains nothing that can be replayed. The lookup
 *    is still a single indexed primary-key hit.
 *
 * 3. Failed logins are counted per account and lock it for a growing interval.
 *    The rate limiter in front handles the per-IP case; this handles the
 *    distributed one, where the attempts arrive from many addresses.
 *
 * 4. Login is constant-time in the sense that matters: an unknown email still
 *    performs a hash verification against a dummy hash, so response time does
 *    not reveal whether an account exists.
 *
 * 5. The client's IP is stored only as an HMAC, so the session table can show
 *    "a different device" without holding an address that identifies a person.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { loadConfig } from './config.js';
import { getDb } from './db.js';

/**
 * argon2id parameters. OWASP's 2024 floor is 19 MiB / t=2 / p=1; this doubles
 * the memory because an admin login happens a handful of times a day and the
 * box has 8 GB. Measured at roughly 90 ms on the target VPS class.
 */
const ARGON_OPTIONS = {
  memoryCost: 40 * 1024, // 40 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

const SESSION_BYTES = 32;
const SESSION_TTL_HOURS = 12;
const MAX_FAILED_LOGINS = 5;

/**
 * Verified against when the email is unknown, so that a wrong email and a wrong
 * password cost the same time. Generated once at module load.
 */
const DUMMY_HASH = await argonHash('password-that-is-never-correct', ARGON_OPTIONS);

export interface SessionUser {
  id: string;
  email: string;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  return argonVerify(hash, plaintext, ARGON_OPTIONS).catch(() => false);
}

/** Costs the same as a real verification, for when the account does not exist. */
export async function verifyAgainstDummy(plaintext: string): Promise<void> {
  await argonVerify(DUMMY_HASH, plaintext, ARGON_OPTIONS).catch(() => false);
}

/** HMAC of an IP address. Lets us spot a session moving without storing the address. */
export function hashIp(ip: string | undefined): Buffer | null {
  if (ip === undefined || ip === '') return null;
  const key = Buffer.from(loadConfig().SESSION_SECRET, 'base64');
  return createHmac('sha256', key).update(ip).digest();
}

/** The database key for a session token. Never store the token itself. */
export function tokenToId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; until: Date };

/**
 * Verifies credentials and updates the lockout counters.
 *
 * Returns 'invalid' for both an unknown email and a wrong password: telling an
 * attacker which one it was hands them a list of valid admin addresses.
 */
export async function verifyLogin(email: string, password: string): Promise<LoginResult> {
  const db = getDb();
  const normalised = email.trim().toLowerCase();

  const user = await db
    .selectFrom('admin_users')
    .select(['id', 'email', 'password_hash', 'failed_logins', 'locked_until'])
    .where('email', '=', normalised)
    .executeTakeFirst();

  if (user === undefined) {
    // Spend the same time as a real verification before answering.
    await argonVerify(DUMMY_HASH, password, ARGON_OPTIONS).catch(() => false);
    return { ok: false, reason: 'invalid' };
  }

  if (user.locked_until !== null && user.locked_until > new Date()) {
    return { ok: false, reason: 'locked', until: user.locked_until };
  }

  const correct = await argonVerify(user.password_hash, password, ARGON_OPTIONS).catch(() => false);

  if (!correct) {
    const failures = user.failed_logins + 1;
    // 5 failures locks for 15 minutes, and each further failure doubles it, so
    // an unattended attack backs itself off rather than grinding forever.
    const lockFor = failures >= MAX_FAILED_LOGINS ? 15 * 2 ** (failures - MAX_FAILED_LOGINS) : 0;

    await db
      .updateTable('admin_users')
      .set({
        failed_logins: failures,
        locked_until: lockFor > 0 ? new Date(Date.now() + lockFor * 60_000) : null,
      })
      .where('id', '=', user.id)
      .execute();

    return { ok: false, reason: 'invalid' };
  }

  await db
    .updateTable('admin_users')
    .set({ failed_logins: 0, locked_until: null, last_login_at: new Date() })
    .where('id', '=', user.id)
    .execute();

  return { ok: true, user: { id: user.id, email: user.email } };
}

/**
 * Creates a session and returns the token to put in the cookie. The token is
 * the only copy: it is not recoverable from the database.
 */
export async function createSession(
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(SESSION_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000);

  await getDb()
    .insertInto('admin_sessions')
    .values({
      id: tokenToId(token),
      user_id: userId,
      ip_hash: hashIp(ip),
      // Truncated: a full UA string is a fingerprint, and the only question we
      // ever ask of it is "does this look like the same browser".
      user_agent: userAgent?.slice(0, 120) ?? null,
      expires_at: expiresAt,
    })
    .execute();

  return { token, expiresAt };
}

/** Resolves a cookie value to a logged-in admin, or null. Expired rows are removed. */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (token === undefined || token === '') return null;

  const db = getDb();
  const row = await db
    .selectFrom('admin_sessions')
    .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.user_id')
    .select(['admin_users.id as id', 'admin_users.email as email', 'admin_sessions.expires_at'])
    .where('admin_sessions.id', '=', tokenToId(token))
    .executeTakeFirst();

  if (row === undefined) return null;

  if (row.expires_at <= new Date()) {
    await destroySession(token);
    return null;
  }

  return { id: row.id, email: row.email };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token === undefined || token === '') return;
  await getDb().deleteFrom('admin_sessions').where('id', '=', tokenToId(token)).execute();
}

/** Housekeeping, called on a timer. Expired sessions are not evidence of anything. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await getDb()
    .deleteFrom('admin_sessions')
    .where('expires_at', '<=', new Date())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

/** Constant-time compare, for CSRF tokens and similar fixed-length secrets. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
