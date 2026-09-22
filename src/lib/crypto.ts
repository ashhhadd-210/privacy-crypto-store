/**
 * Encryption at rest for customer PII, and the blind index that makes it
 * searchable without decrypting it.
 *
 * WHY THIS EXISTS
 *
 * The client's core requirement is that a stolen copy of the database is
 * worthless. So every column holding a name, an address, an email or a phone
 * number is BYTEA, and the plaintext never reaches Postgres. Encryption happens
 * here, in the application, which means the database process, its backups, its
 * WAL and any dump taken from it all contain ciphertext only. The key lives in
 * an env file on the VPS with 0600 permissions, outside the repo and outside
 * the database's reach.
 *
 * LAYOUT
 *
 *   nonce(12) || ciphertext || tag(16)
 *
 * AES-256-GCM. The nonce is random per encryption, so encrypting the same
 * address twice produces different bytes — no equality leaks through the
 * ciphertext. The tag is authentication: a flipped bit anywhere makes
 * decryption throw rather than return plausible-looking garbage.
 *
 * CONTEXT BINDING (the AAD)
 *
 * Every value is encrypted with a context string naming the table and column it
 * belongs to, e.g. "orders.email". The context is authenticated but not stored:
 * decryption must be handed the same string or it fails. This stops a whole
 * class of attack where someone with write access to the database moves
 * ciphertext between rows or columns — pasting one customer's encrypted address
 * into another customer's order, or an email blob into a name field. Without
 * binding, the app would decrypt it happily.
 *
 * THE BLIND INDEX
 *
 * Encrypted columns cannot be searched, but a guest still has to find their
 * order by email. So each searchable column has a companion `_bidx` column
 * holding HMAC-SHA256(blind_index_key, normalised value). Equality lookups run
 * against that. It leaks exactly one thing — whether two rows hold the same
 * value — and nothing about the value itself. It is an HMAC, not a plain hash,
 * so an attacker holding the database cannot test guesses without also holding
 * the key.
 *
 * KEY LOSS
 *
 * There is no recovery. Losing ENCRYPTION_KEY makes every existing order
 * permanently unreadable; that is the design, not a bug. Changing
 * BLIND_INDEX_KEY breaks lookup until every row is re-indexed. Both are backed
 * up separately from the database, in the client's password manager.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Table and column each encrypted value belongs to. Passed as the AES-GCM
 * additional authenticated data, so ciphertext cannot be moved between fields.
 * Add a member here when a new PII column appears; never reuse one.
 */
export type CryptoContext =
  | 'orders.email'
  | 'orders.name'
  | 'orders.address'
  | 'orders.phone'
  | 'customers.email'
  | 'customers.name';

/** Values that get a blind index. Keeps the normalisation rules in one place. */
export type IndexContext = 'orders.email' | 'customers.email';

let encryptionKey: Buffer | null = null;
let blindIndexKey: Buffer | null = null;

function loadKey(name: 'ENCRYPTION_KEY' | 'BLIND_INDEX_KEY'): Buffer {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    throw new Error(
      `${name} is not set. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`${name} is not valid base64`);
  }

  if (key.length !== KEY_BYTES) {
    // Deliberately reports the length and never the value.
    throw new Error(
      `${name} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        `A short key here would silently weaken every encrypted column.`,
    );
  }

  return key;
}

/**
 * Loads and validates both keys. Called once at startup so a misconfigured
 * server fails immediately and loudly, rather than on the first customer order.
 */
export function initCrypto(): void {
  encryptionKey = loadKey('ENCRYPTION_KEY');
  blindIndexKey = loadKey('BLIND_INDEX_KEY');
}

function key(): Buffer {
  if (encryptionKey === null) initCrypto();
  return encryptionKey as Buffer;
}

function indexKey(): Buffer {
  if (blindIndexKey === null) initCrypto();
  return blindIndexKey as Buffer;
}

/**
 * Encrypts one PII value for storage in a BYTEA column.
 *
 * @param plaintext the value as the customer typed it
 * @param context   the table.column it is being stored in
 */
export function encrypt(plaintext: string, context: CryptoContext): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Decrypts a value read from a BYTEA column.
 *
 * Throws if the bytes were tampered with, if the wrong key is configured, or if
 * the value came from a different column than `context` names. All three are
 * failures we want loud: silently returning wrong data would be worse.
 */
export function decrypt(stored: Buffer, context: CryptoContext): string {
  if (stored.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error(`ciphertext too short to be valid (${stored.length} bytes)`);
  }

  const nonce = stored.subarray(0, NONCE_BYTES);
  const ciphertext = stored.subarray(NONCE_BYTES, stored.length - TAG_BYTES);
  const tag = stored.subarray(stored.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key(), nonce);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // The underlying message ("unable to authenticate data") tells an attacker
    // nothing useful, but it tells a maintainer nothing either. Say what it
    // actually means.
    throw new Error(
      `could not decrypt a value stored as ${context}: wrong key, wrong column, or the ` +
        `bytes were modified. The data is not recoverable by retrying.`,
    );
  }
}

/** Optional-value wrappers, for columns like orders.phone_enc that may be NULL. */
export function encryptOptional(
  plaintext: string | null | undefined,
  context: CryptoContext,
): Buffer | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return encrypt(plaintext, context);
}

export function decryptOptional(
  stored: Buffer | null | undefined,
  context: CryptoContext,
): string | null {
  if (stored === null || stored === undefined) return null;
  return decrypt(stored, context);
}

/**
 * Normalisation applied before indexing, so that "  Alice@Example.COM " and
 * "alice@example.com" produce the same index entry. Kept deliberately minimal:
 * anything cleverer (stripping dots in gmail addresses, say) would make two
 * genuinely different addresses collide.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Computes the searchable index for a value. Store this in the `_bidx` column
 * alongside the encrypted value, and query by it.
 */
export function blindIndex(value: string, _context: IndexContext): Buffer {
  return createHmac('sha256', indexKey()).update(normalise(value), 'utf8').digest();
}

/**
 * Constant-time comparison of two blind index values, for the rare case where
 * we compare in application code rather than in a WHERE clause. Postgres
 * comparison of BYTEA is not constant-time either, but that leaks timing about
 * an HMAC, not about the plaintext, so it is not worth contorting the query.
 */
export function blindIndexEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Encrypts a structured address as one blob. The whole object is stored in a
 * single column: the parts are only ever read together, and one ciphertext
 * leaks less shape than six.
 */
export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postcode: string;
  country: string;
}

export function encryptAddress(address: Address): Buffer {
  return encrypt(JSON.stringify(address), 'orders.address');
}

export function decryptAddress(stored: Buffer): Address {
  return JSON.parse(decrypt(stored, 'orders.address')) as Address;
}
