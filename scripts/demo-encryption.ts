/**
 * Demonstrates the encryption layer against the real database.
 *
 *   npm run demo:encryption
 *
 * Writes one test order through the application, then shows what the database
 * actually holds, reads it back, and finds it by email without ever decrypting
 * more than the one matching row. Cleans up after itself.
 *
 * This is the evidence for the client that "customer details are encrypted"
 * means something specific, and the check a future maintainer runs after
 * rotating a key.
 */

import 'dotenv/config';
import { Client } from 'pg';

import {
  encrypt,
  decrypt,
  encryptAddress,
  decryptAddress,
  encryptOptional,
  decryptOptional,
  blindIndex,
  initCrypto,
} from '../src/lib/crypto.js';

const CUSTOMER = {
  email: 'Alice.Buyer@Example.com',
  name: 'Alice Buyer',
  phone: '+1 555 0100',
  address: {
    line1: '1 Test Street',
    line2: 'Apt 4',
    city: 'Testville',
    region: 'TS',
    postcode: '12345',
    country: 'US',
  },
};

const ORDER_NUMBER = 'DEMO-' + Date.now().toString(36).toUpperCase();

function heading(text: string): void {
  console.log('\n' + text);
  console.log('-'.repeat(text.length));
}

async function main(): Promise<void> {
  initCrypto();

  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();

  try {
    heading('1. What the customer typed at checkout');
    console.log(`   name     ${CUSTOMER.name}`);
    console.log(`   email    ${CUSTOMER.email}`);
    console.log(`   phone    ${CUSTOMER.phone}`);
    console.log(`   address  ${CUSTOMER.address.line1}, ${CUSTOMER.address.city} ${CUSTOMER.address.postcode}`);

    // The application encrypts before the values ever reach Postgres.
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (order_number, status, email_enc, email_bidx, name_enc, address_enc, phone_enc,
          subtotal_cents, total_cents)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6, 2400, 2400)
       RETURNING id`,
      [
        ORDER_NUMBER,
        encrypt(CUSTOMER.email, 'orders.email'),
        blindIndex(CUSTOMER.email, 'orders.email'),
        encrypt(CUSTOMER.name, 'orders.name'),
        encryptAddress(CUSTOMER.address),
        encryptOptional(CUSTOMER.phone, 'orders.phone'),
      ],
    );
    const orderId = inserted[0]!.id;

    heading('2. What the database actually stores (first 48 bytes, hex)');
    const { rows: raw } = await client.query<Record<string, string>>(
      `SELECT encode(substring(name_enc    from 1 for 24), 'hex') AS name_enc,
              encode(substring(email_enc   from 1 for 24), 'hex') AS email_enc,
              encode(substring(address_enc from 1 for 24), 'hex') AS address_enc,
              encode(substring(email_bidx  from 1 for 24), 'hex') AS email_bidx
         FROM orders WHERE id = $1`,
      [orderId],
    );
    for (const [column, value] of Object.entries(raw[0]!)) {
      console.log(`   ${column.padEnd(12)} ${value}...`);
    }
    console.log('\n   No name, no address, no email. A stolen dump ends here.');

    heading('3. Searching the database for the plaintext finds nothing');
    const { rows: search } = await client.query<{ hits: string }>(
      `SELECT count(*)::text AS hits FROM orders
        WHERE position('Alice'  in encode(name_enc, 'escape')) > 0
           OR position('Example' in encode(email_enc, 'escape')) > 0
           OR position('Testville' in encode(address_enc, 'escape')) > 0`,
    );
    console.log(`   rows containing "Alice", "Example" or "Testville": ${search[0]!.hits}`);

    heading('4. Guest order lookup: order number + email, no decryption to search');
    // The lookup matches on the blind index, so Postgres compares 32 bytes of
    // HMAC. It never sees the address, and we decrypt exactly one row.
    const { rows: found } = await client.query<{
      id: string;
      name_enc: Buffer;
      email_enc: Buffer;
      address_enc: Buffer;
      phone_enc: Buffer | null;
    }>(
      `SELECT id, name_enc, email_enc, address_enc, phone_enc
         FROM orders
        WHERE order_number = $1 AND email_bidx = $2`,
      [ORDER_NUMBER, blindIndex('  ALICE.BUYER@example.com  ', 'orders.email')],
    );
    console.log(`   query used the blind index of a differently-cased, padded address`);
    console.log(`   rows matched: ${found.length}`);

    heading('5. Decrypted back, in the application only');
    const row = found[0]!;
    const address = decryptAddress(row.address_enc);
    console.log(`   name     ${decrypt(row.name_enc, 'orders.name')}`);
    console.log(`   email    ${decrypt(row.email_enc, 'orders.email')}`);
    console.log(`   phone    ${decryptOptional(row.phone_enc, 'orders.phone')}`);
    console.log(`   address  ${address.line1}, ${address.city} ${address.postcode}`);

    heading('6. Tampering with the stored bytes is detected, not silently accepted');
    await client.query(
      `UPDATE orders SET name_enc = set_byte(name_enc, 20, get_byte(name_enc, 20) # 1) WHERE id = $1`,
      [orderId],
    );
    const { rows: tampered } = await client.query<{ name_enc: Buffer }>(
      `SELECT name_enc FROM orders WHERE id = $1`,
      [orderId],
    );
    try {
      decrypt(tampered[0]!.name_enc, 'orders.name');
      console.log('   PROBLEM: tampered value decrypted. Investigate before shipping.');
      process.exitCode = 1;
    } catch (err) {
      console.log(`   one bit flipped in the database -> ${(err as Error).message.split(':')[0]}`);
    }

    await client.query('DELETE FROM orders WHERE id = $1', [orderId]);
    console.log('\nDemo order deleted. Nothing left behind.\n');
  } finally {
    await client.end();
  }
}

await main();
