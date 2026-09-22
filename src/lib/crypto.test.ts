/**
 * Tests for the PII encryption layer.
 *
 * These are the tests the OWASP round in week 4 will be graded against, so they
 * assert the properties that matter rather than that the functions return
 * strings: that the same input never produces the same bytes twice, that a
 * modified byte is detected, that the wrong key fails closed, and that
 * ciphertext cannot be moved between columns.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Keys must exist before the module under test loads them. Set here so the
// suite is self-contained and never depends on a developer's .env.
process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
process.env['BLIND_INDEX_KEY'] = randomBytes(32).toString('base64');

const {
  encrypt,
  decrypt,
  encryptOptional,
  decryptOptional,
  blindIndex,
  blindIndexEquals,
  encryptAddress,
  decryptAddress,
  initCrypto,
} = await import('./crypto.js');

const EMAIL = 'Alice.Buyer@Example.com';

test('a value survives a round trip unchanged', () => {
  assert.equal(decrypt(encrypt(EMAIL, 'orders.email'), 'orders.email'), EMAIL);
});

test('non-ASCII and long values survive', () => {
  const awkward = 'Łukasz Żółć — 北京市朝阳区 — ' + 'x'.repeat(5000);
  assert.equal(decrypt(encrypt(awkward, 'orders.name'), 'orders.name'), awkward);
});

test('an empty string round trips (distinct from NULL)', () => {
  assert.equal(decrypt(encrypt('', 'orders.name'), 'orders.name'), '');
});

test('the same value encrypted twice produces different bytes', () => {
  // Without this, two customers sharing a city would be visible as identical
  // ciphertext, and the database would leak equality it was meant to hide.
  const a = encrypt(EMAIL, 'orders.email');
  const b = encrypt(EMAIL, 'orders.email');
  assert.notEqual(a.toString('hex'), b.toString('hex'));
  assert.equal(decrypt(a, 'orders.email'), decrypt(b, 'orders.email'));
});

test('the stored layout is nonce(12) || ciphertext || tag(16)', () => {
  const plaintext = 'exactly twenty chars';
  const stored = encrypt(plaintext, 'orders.name');
  assert.equal(stored.length, 12 + Buffer.byteLength(plaintext) + 16);
});

test('the plaintext never appears in the stored bytes', () => {
  const stored = encrypt(EMAIL, 'orders.email');
  assert.ok(!stored.toString('utf8').includes('Alice'));
  assert.ok(!stored.toString('utf8').includes('Example'));
});

test('a single flipped bit is detected', () => {
  const stored = encrypt(EMAIL, 'orders.email');
  const tampered = Buffer.from(stored);
  tampered[20] = tampered[20]! ^ 0x01;
  assert.throws(() => decrypt(tampered, 'orders.email'), /could not decrypt/);
});

test('a truncated value is rejected rather than half-decrypted', () => {
  const stored = encrypt(EMAIL, 'orders.email');
  assert.throws(() => decrypt(stored.subarray(0, 20), 'orders.email'), /could not decrypt|too short/);
  assert.throws(() => decrypt(Buffer.alloc(4), 'orders.email'), /too short/);
});

test('ciphertext cannot be moved to another column', () => {
  // The attack: someone with write access to the database pastes one
  // customer's encrypted email into another row's name column. Context binding
  // makes the read fail instead of succeeding with the wrong data.
  const asEmail = encrypt(EMAIL, 'orders.email');
  assert.throws(() => decrypt(asEmail, 'orders.name'), /could not decrypt/);
  assert.throws(() => decrypt(asEmail, 'customers.email'), /could not decrypt/);
  assert.equal(decrypt(asEmail, 'orders.email'), EMAIL);
});

test('the wrong key fails closed', () => {
  const stored = encrypt(EMAIL, 'orders.email');
  const original = process.env['ENCRYPTION_KEY'];
  try {
    process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
    initCrypto();
    assert.throws(() => decrypt(stored, 'orders.email'), /could not decrypt/);
  } finally {
    process.env['ENCRYPTION_KEY'] = original;
    initCrypto();
  }
  assert.equal(decrypt(stored, 'orders.email'), EMAIL);
});

test('a key of the wrong length is refused at load', () => {
  const original = process.env['ENCRYPTION_KEY'];
  try {
    process.env['ENCRYPTION_KEY'] = randomBytes(16).toString('base64');
    assert.throws(() => initCrypto(), /must decode to 32 bytes, got 16/);
    process.env['ENCRYPTION_KEY'] = '';
    assert.throws(() => initCrypto(), /is not set/);
  } finally {
    process.env['ENCRYPTION_KEY'] = original;
    initCrypto();
  }
});

test('optional columns treat NULL and empty as absent', () => {
  assert.equal(encryptOptional(null, 'orders.phone'), null);
  assert.equal(encryptOptional(undefined, 'orders.phone'), null);
  assert.equal(encryptOptional('', 'orders.phone'), null);
  assert.equal(decryptOptional(null, 'orders.phone'), null);

  const stored = encryptOptional('+1 555 0100', 'orders.phone');
  assert.ok(stored instanceof Buffer);
  assert.equal(decryptOptional(stored, 'orders.phone'), '+1 555 0100');
});

test('an address round trips as a structure', () => {
  const address = {
    line1: '1 Test Street',
    line2: 'Apt 4',
    city: 'Testville',
    region: 'TS',
    postcode: '12345',
    country: 'US',
  };
  assert.deepEqual(decryptAddress(encryptAddress(address)), address);
});

test('the blind index is stable, and case and whitespace insensitive', () => {
  const a = blindIndex(EMAIL, 'orders.email');
  const b = blindIndex('  alice.buyer@example.com  ', 'orders.email');
  assert.ok(blindIndexEquals(a, b));
  assert.equal(a.length, 32);
});

test('different values produce different index entries', () => {
  const a = blindIndex('alice@example.com', 'orders.email');
  const b = blindIndex('alice@example.co', 'orders.email');
  assert.ok(!blindIndexEquals(a, b));
});

test('the blind index does not reveal the value', () => {
  const idx = blindIndex(EMAIL, 'orders.email').toString('hex');
  assert.ok(!idx.includes(Buffer.from('alice').toString('hex')));
  // It is an HMAC, not a bare hash: the same address under a different key
  // gives a different entry, so a stolen database alone cannot be tested
  // against a list of guessed emails.
  const original = process.env['BLIND_INDEX_KEY'];
  try {
    process.env['BLIND_INDEX_KEY'] = randomBytes(32).toString('base64');
    initCrypto();
    assert.notEqual(blindIndex(EMAIL, 'orders.email').toString('hex'), idx);
  } finally {
    process.env['BLIND_INDEX_KEY'] = original;
    initCrypto();
  }
});
