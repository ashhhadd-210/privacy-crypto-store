/**
 * Builds the application. Starting it lives in main.ts, so that tests can
 * construct a server without binding a port, and so nothing has to guess
 * whether this file was invoked directly.
 *
 * Wiring order matters here and is deliberate: security plugins register before
 * anything that can serve a response, so there is no window in which a route
 * answers without headers, CSRF or rate limiting applied.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import view from '@fastify/view';
import Fastify, { type FastifyError } from 'fastify';
import nunjucks from 'nunjucks';

import { loadConfig } from './lib/config.js';
import { getDb } from './lib/db.js';
import { createLogger, requestIdFactory } from './lib/logger.js';
import { initCrypto } from './lib/crypto.js';
import { adminRoutes } from './routes/admin.js';
import { cartRoutes } from './routes/cart.js';
import { checkoutRoutes } from './routes/checkout.js';
import { healthRoutes } from './routes/health.js';
import { shopRoutes } from './routes/shop.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Short content hash of the stylesheet, appended to its URL as ?v=.
 *
 * The static handler serves assets `immutable` with a seven-day cache, which is
 * what keeps repeat requests at Cloudflare instead of reaching the app. That is
 * only safe if the URL changes when the file does — otherwise a deploy leaves
 * every returning visitor on last week's stylesheet, and the only fix is asking
 * them to hard-refresh. There is no asset build step yet, so the hash is
 * computed here at boot. When a build step lands it should hash the filename
 * itself and this can go.
 */
function assetVersion(): string {
  try {
    return createHash('sha256')
      .update(readFileSync(join(HERE, 'public', 'assets', 'app.css')))
      .digest('hex')
      .slice(0, 8);
  } catch {
    return 'dev';
  }
}

export async function buildServer() {
  const config = loadConfig();

  // Fail before listening if the keys are missing or malformed, rather than on
  // the first order.
  initCrypto();

  const app = Fastify({
    loggerInstance: createLogger(),
    genReqId: requestIdFactory,
    // Caddy terminates TLS and sets the forwarded headers; without this every
    // request would appear to come from the proxy and rate limiting would ban
    // the whole edge or nobody.
    trustProxy: true,
    // A storefront has no legitimate use for large bodies. Product images come
    // through a separate multipart route in week 3 with its own limit.
    bodyLimit: 256 * 1024,
    disableRequestLogging: false,
  });

  // --- security plugins, before any route ---------------------------------

  await app.register(helmet, {
    // Caddy sets the canonical headers at the edge; these are the same values
    // applied again at the origin so the guarantee survives a proxy
    // misconfiguration or a direct connection during a deploy.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: config.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    // helmet defaults to SAMEORIGIN; nothing here is ever framed, including by
    // us, and DENY is what the Caddyfile sets at the edge. The two must agree
    // or the weaker one wins wherever it is applied last.
    xFrameOptions: { action: 'deny' },
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(formbody);

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Bots get the same terse answer as everyone else.
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Too many requests' }),
  });

  // Every state-changing form must carry a token. Registered after cookie
  // because it stores the secret in one.
  await app.register(csrf, { sessionPlugin: '@fastify/cookie' });

  // --- views and static assets --------------------------------------------

  await app.register(view, {
    engine: { nunjucks },
    root: join(HERE, 'views'),
    // Nunjucks autoescapes by default; stated explicitly because turning it off
    // would be the single fastest way to introduce XSS into this codebase.
    options: { autoescape: true, noCache: !config.isProduction },
    defaultContext: { title: 'Store', assetVersion: assetVersion() },
  });

  await app.register(fastifyStatic, {
    root: join(HERE, 'public'),
    prefix: '/',
    index: false,
    // Safe only because every asset URL carries ?v=<content hash>; see
    // assetVersion() above. Product images join them from /uploads in week 3.
    cacheControl: true,
    maxAge: '7d',
    immutable: true,
  });

  // --- error handling ------------------------------------------------------

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).view('error.njk', {
      statusCode: 404,
      message: 'That page does not exist.',
      requestId: request.id,
      title: 'Not found',
    });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    // The full error, with stack, goes to the log where only we can read it.
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.warn({ err: error, statusCode: status }, 'request rejected');

    // The visitor gets a status code and a request id, never a stack trace,
    // a SQL fragment or a file path.
    const message =
      status === 429
        ? 'Too many requests. Please wait a moment.'
        : status >= 500
          ? 'Something went wrong at our end.'
          : 'That request could not be processed.';

    return reply.code(status).view('error.njk', {
      statusCode: status,
      message,
      requestId: request.id,
      title: 'Error',
    });
  });

  // --- routes --------------------------------------------------------------

  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await app.register(shopRoutes);
  await app.register(cartRoutes);
  await app.register(checkoutRoutes);

  return app;
}

export { getDb };
