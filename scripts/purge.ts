/**
 * The scheduled retention purge. Run nightly on the VPS by a systemd timer:
 *
 *   docker compose --profile cron run --rm purge
 *
 * Everything it does is in src/lib/retention.ts; this just loads the config,
 * runs it, prints counts (never personal data) and exits non-zero on error so
 * the timer's failure shows in `systemctl status`.
 */

import { initCrypto } from '../src/lib/crypto.js';
import { closeDb, getDb } from '../src/lib/db.js';
import { runPurge } from '../src/lib/retention.js';

initCrypto();
try {
  const run = await runPurge(getDb(), 'schedule');
  console.log(
    `purge: retention ${run.retention_days} days, cutoff ${run.cutoff_at.toISOString()}, ` +
      `${run.orders_purged} orders, ${run.customers_purged} customers, ${run.webhooks_purged} webhooks` +
      (run.skipped ? ' (disabled in settings, nothing deleted)' : ''),
  );
  if (run.error) {
    console.error(`purge: error: ${run.error}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
