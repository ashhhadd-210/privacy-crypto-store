/**
 * Reads stdin, writes it to stdout locked to the client's age public key
 * (EXPORT_AGE_RECIPIENT). Used by the nightly backup so the dump is never on
 * disk in readable form:
 *
 *   pg_dump ... | node dist/scripts/age-encrypt.js > store-YYYY-MM-DD.sql.age
 *
 * With --decrypt and AGE_IDENTITY_FILE set, does the reverse (restore drill).
 */

import { readFileSync } from 'node:fs';

import { decrypt, encrypt } from '../src/lib/age.js';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const input = Buffer.concat(chunks);

if (process.argv.includes('--decrypt')) {
  const file = process.env['AGE_IDENTITY_FILE'];
  if (!file) throw new Error('AGE_IDENTITY_FILE is not set');
  const identity = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-1'));
  if (!identity) throw new Error('no AGE-SECRET-KEY-1 line in the identity file');
  process.stdout.write(decrypt(input, identity.trim()));
} else {
  const recipient = process.env['EXPORT_AGE_RECIPIENT'];
  if (!recipient) throw new Error('EXPORT_AGE_RECIPIENT is not set: refusing to write an unencrypted backup');
  process.stdout.write(encrypt(input, [recipient]));
}
