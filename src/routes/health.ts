/**
 * Health endpoints.
 *
 * `/healthz` is what the deploy pipeline calls after starting a new container,
 * and what the compose healthcheck polls. It must answer honestly: if it
 * returns 200 while the database is unreachable, the pipeline promotes a broken
 * release and rolls nothing back.
 *
 * It deliberately reveals nothing. No version string, no hostname, no database
 * error text — those are reconnaissance for anyone who finds the endpoint, and
 * the endpoint is reachable from Cloudflare.
 */

import type { FastifyInstance } from 'fastify';

import { pingDb } from '../lib/db.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness: the process is up and serving. Used by the container runtime to
   * decide whether to restart, so it must not depend on the database — a
   * database blip should not cause a restart loop of a perfectly good app.
   */
  app.get('/healthz', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  /**
   * Readiness: the app can actually serve traffic, database included. This is
   * the one the deploy pipeline gates on before switching over.
   */
  app.get('/readyz', async (_request, reply) => {
    const dbOk = await pingDb();

    if (!dbOk) {
      // Logged as a plain event; the underlying error is already logged by the
      // db layer and must not be echoed to the caller.
      _request.log.error('readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }

    return reply.code(200).send({ status: 'ready' });
  });
}
