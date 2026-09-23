/**
 * Process entry point: build the server, listen, and shut down cleanly.
 *
 * Separate from server.ts on purpose. Tests import `buildServer()` and never
 * bind a port, and nothing here depends on detecting whether the file was run
 * directly — a check that is deceptively easy to get wrong, because
 * `import.meta.url` is a URL and percent-encodes characters that a plain path
 * comparison does not.
 */

import { buildServer } from './server.js';
import { closeDb } from './lib/db.js';
import { loadConfig } from './lib/config.js';
import { purgeExpiredSessions } from './lib/session.js';

const config = loadConfig();
const app = await buildServer();

// Expired sessions are not evidence of anything; clear them hourly.
const sessionSweep = setInterval(() => {
  purgeExpiredSessions().catch((err: unknown) => app.log.error({ err }, 'session sweep failed'));
}, 3_600_000);
sessionSweep.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sessionSweep);
  await app.close();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  // 0.0.0.0 inside the container; the host firewall and the compose network are
  // what keep this off the public internet, not the bind address.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  await closeDb();
  process.exit(1);
}
