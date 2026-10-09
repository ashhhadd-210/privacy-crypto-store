/**
 * Every few minutes on the VPS (davmad-reconcile.timer):
 *
 *   1. Ask BTCPay about every invoice we still think is open and more than five
 *      minutes old, and apply whatever it says through the same
 *      applyPaymentEvent the webhook uses. A webhook that never arrived (server
 *      restarting, network blip) costs a few minutes, not a lost order.
 *   2. Send any order emails still waiting in the outbox.
 *
 * Prints counts only.
 */

import { BtcpayUnavailable, btcpayConfigured, getInvoice } from '../src/lib/btcpay.js';
import { initCrypto } from '../src/lib/crypto.js';
import { closeDb, getDb } from '../src/lib/db.js';
import { processOutbox } from '../src/lib/mailer.js';
import { applyPaymentEvent, eventFromInvoice } from '../src/lib/payments.js';

initCrypto();
const db = getDb();
try {
  let checked = 0;
  let changed = 0;
  if (btcpayConfigured()) {
    const open = await db
      .selectFrom('payments')
      .select('btcpay_invoice_id')
      .where('status', 'in', ['new', 'processing'])
      .where('created_at', '<', new Date(Date.now() - 5 * 60_000))
      .limit(200)
      .execute();
    for (const p of open) {
      checked += 1;
      try {
        const ev = eventFromInvoice(await getInvoice(p.btcpay_invoice_id));
        if (ev !== null && ev.type !== 'processing') {
          const outcome = await applyPaymentEvent(db, ev);
          if (outcome !== 'repeat') changed += 1;
        }
      } catch (err) {
        if (!(err instanceof BtcpayUnavailable)) throw err;
        console.error(`reconcile: BTCPay unavailable (${err.message}); will retry next run`);
        break;
      }
    }
  }
  const mail = await processOutbox(db, 100);
  console.log(`reconcile: ${checked} open invoices checked, ${changed} updated; emails ${mail.sent} sent, ${mail.failed} failed, ${mail.waiting} waiting`);
} finally {
  await closeDb();
}
