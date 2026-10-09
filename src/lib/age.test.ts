/**
 * age format tests: round trips, wrong keys, tampering, several recipients,
 * and the standard bech32 key encoding.
 *
 * NOT yet proven here: that the reference `age` tool opens our files. That
 * needs the tool, which is checked on the server (`age -d`) as part of the
 * restore drill before go-live. See docs/04_TECH_DECISIONS.md.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { bech32Decode, bech32Encode, decrypt, encrypt, generateIdentity, isRecipient } from './age.js';

test('round trip: what we lock, the secret key opens', () => {
  const { identity, recipient } = generateIdentity();
  for (const size of [0, 1, 1000, 64 * 1024, 64 * 1024 + 1, 200_000]) {
    const plain = randomBytes(size);
    const locked = encrypt(plain, [recipient]);
    assert.ok(locked.subarray(0, 21).toString() === 'age-encryption.org/v1', 'starts with the age header');
    assert.deepEqual(decrypt(locked, identity), plain, `size ${size}`);
  }
});

test('the wrong key cannot open it', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.throws(() => decrypt(encrypt(Buffer.from('orders'), [a.recipient]), b.identity), /no matching recipient/);
});

test('one flipped byte anywhere is detected', () => {
  const { identity, recipient } = generateIdentity();
  const locked = encrypt(Buffer.from('x'.repeat(5000)), [recipient]);
  for (const pos of [30, locked.indexOf('---') + 6, locked.length - 20]) {
    const bad = Buffer.from(locked);
    bad[pos] = (bad[pos] as number) ^ 1;
    assert.throws(() => decrypt(bad, identity), Error, `byte ${pos}`);
  }
});

test('several recipients can each open the same file', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const locked = encrypt(Buffer.from('shared'), [a.recipient, b.recipient]);
  assert.equal(decrypt(locked, a.identity).toString(), 'shared');
  assert.equal(decrypt(locked, b.identity).toString(), 'shared');
});

test('the plaintext never appears in the file', () => {
  const { recipient } = generateIdentity();
  const secret = 'Alex Example, 1 Example Road';
  assert.ok(!encrypt(Buffer.from(secret.repeat(50)), [recipient]).includes(Buffer.from('Alex Example')));
});

test('keys: bech32 round trip, checksums enforced', () => {
  const raw = randomBytes(32);
  const s = bech32Encode('age', raw);
  assert.ok(s.startsWith('age1'));
  assert.deepEqual(bech32Decode(s, 'age'), raw);
  assert.ok(isRecipient(s));
  const typo = s.slice(0, -1) + (s.endsWith('q') ? 'p' : 'q');
  assert.equal(isRecipient(typo), false);
  assert.equal(isRecipient('age1notakey'), false);
  assert.equal(isRecipient(''), false);
});

test('the BIP-173 published valid string checks out (our bech32 is the standard one)', () => {
  // From BIP-173's list of valid bech32 strings.
  assert.doesNotThrow(() => bech32Decode('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw', 'abcdef'));
  assert.doesNotThrow(() => bech32Decode('A12UEL5L', 'a'));
});
