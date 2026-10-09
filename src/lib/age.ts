/**
 * Encryption to an `age` public key (https://age-encryption.org/v1), using
 * only Node's built-in crypto: X25519, HKDF-SHA256, HMAC-SHA256 and
 * ChaCha20-Poly1305, exactly as the format specifies.
 *
 * Used for the client's encrypted export and the database backups. The store
 * holds only the public key ("age1..."), so it can lock a file but never open
 * one: the matching secret key stays with the client, offline. Any `age`
 * implementation opens the result (`age -d -i key.txt file.age`).
 *
 * `decrypt` exists for tests and for the restore drill, given a secret key.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const INTRO = 'age-encryption.org/v1';
const CHUNK = 64 * 1024;
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

// --- bech32 (BIP-173), as age uses for its keys --------------------------------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk >>> 0;
}
const hrpExpand = (hrp: string) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [], max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max))) throw new Error('invalid key padding');
  return out;
}
export function bech32Decode(str: string, expectedHrp: string): Buffer {
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || s.slice(0, pos) !== expectedHrp) throw new Error(`not an ${expectedHrp} key`);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error('invalid key character');
    return i;
  });
  if (data.length < 6 || polymod(hrpExpand(expectedHrp).concat(data)) !== 1) throw new Error('key checksum does not match');
  return Buffer.from(convertBits(data.slice(0, -6), 5, 8, false));
}
export function bech32Encode(hrp: string, bytes: Buffer): string {
  const data = convertBits([...bytes], 8, 5, true);
  const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(check).map((d) => CHARSET[d]).join('')}`;
}

// --- primitives ----------------------------------------------------------------
const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
const unb64 = (s: string) => Buffer.from(s, 'base64');
const hkdf = (ikm: Buffer, salt: Buffer, info: string) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
function seal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}
const x25519Public = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const x25519Private = (raw: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const rawPublic = (k: ReturnType<typeof createPublicKey>) => k.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
const rawPrivate = (k: ReturnType<typeof createPrivateKey>) => k.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length);
const streamNonce = (counter: number, last: boolean) => {
  const n = Buffer.alloc(12);
  n.writeUIntBE(counter, 5, 6);
  n[11] = last ? 1 : 0;
  return n;
};

export function isRecipient(s: string): boolean {
  try {
    return bech32Decode(s, 'age').length === 32;
  } catch {
    return false;
  }
}

/** Locks `plaintext` so that only the holders of the matching secret keys can open it. */
export function encrypt(plaintext: Buffer, recipients: string[]): Buffer {
  if (recipients.length === 0) throw new Error('no recipient');
  const fileKey = randomBytes(16);
  const lines = [INTRO];
  for (const r of recipients) {
    const recipient = bech32Decode(r, 'age');
    if (recipient.length !== 32) throw new Error('recipient must be 32 bytes');
    const eph = generateKeyPairSync('x25519');
    const share = rawPublic(eph.publicKey);
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipient) });
    if (shared.every((b) => b === 0)) throw new Error('bad recipient');
    const wrapKey = hkdf(shared, Buffer.concat([share, recipient]), 'age-encryption.org/v1/X25519');
    lines.push(`-> X25519 ${b64(share)}`, b64(seal(wrapKey, Buffer.alloc(12), fileKey)));
  }
  const headerNoMac = `${lines.join('\n')}\n---`;
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(headerNoMac).digest();
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, 'payload');
  const chunks: Buffer[] = [];
  const count = Math.max(1, Math.ceil(plaintext.length / CHUNK));
  for (let i = 0; i < count; i++) {
    chunks.push(seal(payloadKey, streamNonce(i, i === count - 1), plaintext.subarray(i * CHUNK, (i + 1) * CHUNK)));
  }
  return Buffer.concat([Buffer.from(`${headerNoMac} ${b64(mac)}\n`), nonce, ...chunks]);
}

/** Opens a file locked by `encrypt` (or by the age tool) with an AGE-SECRET-KEY-1... identity. */
export function decrypt(file: Buffer, identity: string): Buffer {
  const secret = bech32Decode(identity, 'age-secret-key-');
  const priv = x25519Private(secret);
  const ourPublic = rawPublic(createPublicKey(priv));
  const end = file.indexOf('\n---');
  const macLineEnd = file.indexOf('\n', end + 1);
  if (end < 0 || macLineEnd < 0) throw new Error('not an age file');
  const headerNoMac = file.subarray(0, end + 4).toString('utf8');
  const mac = unb64(file.subarray(end + 5, macLineEnd).toString('utf8'));
  const lines = headerNoMac.split('\n');
  if (lines[0] !== INTRO) throw new Error('not an age v1 file');

  let fileKey: Buffer | null = null;
  for (let i = 1; i < lines.length - 1; i++) {
    const m = /^-> X25519 (\S+)$/.exec(lines[i] as string);
    if (!m) continue;
    const share = unb64(m[1] as string);
    const shared = diffieHellman({ privateKey: priv, publicKey: x25519Public(share) });
    const wrapKey = hkdf(shared, Buffer.concat([share, ourPublic]), 'age-encryption.org/v1/X25519');
    try {
      fileKey = open(wrapKey, Buffer.alloc(12), unb64(lines[i + 1] as string));
      break;
    } catch {
      continue;
    }
  }
  if (fileKey === null) throw new Error('no matching recipient');
  const expected = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(headerNoMac).digest();
  if (!expected.equals(mac)) throw new Error('header MAC does not match');

  const body = file.subarray(macLineEnd + 1);
  const payloadKey = hkdf(fileKey, body.subarray(0, 16), 'payload');
  const sealed = body.subarray(16);
  const out: Buffer[] = [];
  const size = CHUNK + 16;
  const count = Math.max(1, Math.ceil(sealed.length / size));
  for (let i = 0; i < count; i++) out.push(open(payloadKey, streamNonce(i, i === count - 1), sealed.subarray(i * size, (i + 1) * size)));
  return Buffer.concat(out);
}

/** A fresh keypair, for tests and the restore drill. The client makes theirs with age-keygen. */
export function generateIdentity(): { identity: string; recipient: string } {
  const kp = generateKeyPairSync('x25519');
  return {
    identity: bech32Encode('age-secret-key-', rawPrivate(kp.privateKey)).toUpperCase(),
    recipient: bech32Encode('age', rawPublic(kp.publicKey)),
  };
}
