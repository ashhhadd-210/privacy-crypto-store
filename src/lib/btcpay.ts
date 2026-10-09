/**
 * BTCPay Server, Greenfield API. Only the three calls the store needs:
 * create an invoice, read one, and invalidate one.
 *
 * The store never sees a wallet, a key that can spend, or the customer's
 * payment details. It asks the client's own BTCPay to bill an amount, sends the
 * customer there, and learns the outcome from a signed webhook.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { loadConfig } from './config.js';

export class BtcpayUnavailable extends Error {}

export interface Invoice {
  id: string;
  checkoutLink: string;
  status: 'New' | 'Processing' | 'Expired' | 'Invalid' | 'Settled';
  additionalStatus?: string;
  expirationTime: number; // unix seconds
  amount: string;
  currency: string;
}

function settings() {
  const c = loadConfig();
  if (!c.BTCPAY_URL || !c.BTCPAY_STORE_ID || !c.BTCPAY_API_KEY) throw new BtcpayUnavailable('BTCPay is not configured');
  return { base: c.BTCPAY_URL.replace(/\/+$/, ''), store: c.BTCPAY_STORE_ID, key: c.BTCPAY_API_KEY };
}

export function btcpayConfigured(): boolean {
  const c = loadConfig();
  return Boolean(c.BTCPAY_URL && c.BTCPAY_STORE_ID && c.BTCPAY_API_KEY && c.BTCPAY_WEBHOOK_SECRET);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { base, store, key } = settings();
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/stores/${encodeURIComponent(store)}${path}`, {
      method,
      headers: { authorization: `token ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new BtcpayUnavailable(`BTCPay unreachable: ${(err as Error).name}`);
  }
  if (!res.ok) throw new BtcpayUnavailable(`BTCPay answered ${res.status} to ${method} ${path.split('/')[1] ?? ''}`);
  return (await res.json()) as T;
}

/**
 * The store talks to BTCPay over the internal Docker network, but the
 * customer's browser must be sent to BTCPay's public address. Rewrite the
 * link's origin so it never points at an internal host name.
 */
function publicLink(link: string): string {
  const pub = loadConfig().BTCPAY_PUBLIC_URL;
  if (!pub) return link;
  const u = new URL(link);
  const p = new URL(pub);
  u.protocol = p.protocol;
  u.host = p.host;
  return u.toString();
}

export async function createInvoice(opts: {
  amountCents: number;
  currency: string;
  orderId: string;
  orderNumber: string;
  redirectUrl: string;
}): Promise<Invoice> {
  const inv = await call<Invoice>('POST', '/invoices', {
    amount: (opts.amountCents / 100).toFixed(2),
    currency: opts.currency,
    // Only our own ids go to BTCPay: never a name, an email or an address.
    metadata: { orderId: opts.orderId, orderNumber: opts.orderNumber },
    checkout: { redirectURL: opts.redirectUrl, redirectAutomatically: true, expirationMinutes: 60 },
  });
  return { ...inv, checkoutLink: publicLink(inv.checkoutLink) };
}

export async function getInvoice(id: string): Promise<Invoice> {
  return call<Invoice>('GET', `/invoices/${encodeURIComponent(id)}`);
}

export async function invalidateInvoice(id: string): Promise<void> {
  await call<unknown>('POST', `/invoices/${encodeURIComponent(id)}/status`, { status: 'Invalid' });
}

/** BTCPay signs the raw body: `BTCPay-Sig: sha256=<hex HMAC>`. */
export function verifyWebhook(rawBody: Buffer, header: string | undefined): boolean {
  const secret = loadConfig().BTCPAY_WEBHOOK_SECRET;
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
