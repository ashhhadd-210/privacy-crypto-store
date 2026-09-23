/**
 * Creates or resets the admin account.
 *
 *   npm run admin:create -- you@example.com
 *
 * The password is generated here rather than chosen, printed once, and never
 * stored anywhere but the database as an argon2id hash. At handover the client
 * sets their own through the admin panel; until then this is how the account
 * exists at all.
 *
 * Deliberately not seeded by a migration with a default password: a store that
 * ships with a known admin password is a store with no admin password.
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';

import { closeDb, getDb } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/session.js';

/**
 * 24 characters from an unambiguous alphabet: no O/0, no l/1/I. The client will
 * type this by hand at least once, and a password that is hard to read is a
 * password that ends up written on something.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(24);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();

  if (email === undefined || !email.includes('@')) {
    console.error('usage: npm run admin:create -- you@example.com');
    process.exit(1);
  }

  const db = getDb();
  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  const existing = await db
    .selectFrom('admin_users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing !== undefined) {
    await db
      .updateTable('admin_users')
      .set({ password_hash: passwordHash, failed_logins: 0, locked_until: null })
      .where('id', '=', existing.id)
      .execute();
    console.log(`\nPassword reset for ${email}`);
  } else {
    await db
      .insertInto('admin_users')
      .values({ email, password_hash: passwordHash, totp_secret: null, locked_until: null, last_login_at: null })
      .execute();
    console.log(`\nAdmin account created for ${email}`);
  }

  await db
    .insertInto('audit_log')
    .values({
      actor: 'system',
      action: existing ? 'admin.password_reset' : 'admin.create',
      entity: 'admin_users',
      entity_id: null,
    })
    .execute();

  console.log(`\n  password: ${password}\n`);
  console.log('Shown once. Put it in a password manager now; it is not recoverable.');
  console.log('It can be reset by running this command again.\n');

  await closeDb();
}

await main();
