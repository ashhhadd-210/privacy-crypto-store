/**
 * Structured logging, built so it cannot leak customer data.
 *
 * The client's promise to their customers is that their details are not lying
 * around. Logs are where that promise usually breaks: a framework's default
 * request logger writes the query string, the body and every header, and six
 * months later the server has a plaintext archive of everything the database
 * was carefully encrypting.
 *
 * So this logger is deny-by-default. Nothing about a request is logged except
 * the fields listed in `serializers` below — method, route, status, duration.
 * No body, no query string, no headers beyond a request id. If a future route
 * needs more context it must add a named field deliberately, and that field
 * must not be a person.
 *
 * `redact` is the second line: if something slips through with a familiar name
 * (password, token, key, email, address), it is replaced before it is written.
 */

import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

import { loadConfig } from './config.js';

/**
 * Field names that must never appear in a log line, wherever they occur.
 * Belt and braces: the serializers below already refuse to pass most of these
 * along, but a hand-written `log.info({ user })` somewhere in week four should
 * not be the thing that undoes the design.
 */
const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'email',
  'name',
  'phone',
  'address',
  'xpub',
  '*.password',
  '*.token',
  '*.email',
  '*.name',
  '*.phone',
  '*.address',
  'req.headers',
  'res.headers',
];

export function createLogger(): Logger {
  const config = loadConfig();

  return pino({
    level: process.env['LOG_LEVEL'] ?? (config.isProduction ? 'info' : 'debug'),

    redact: { paths: REDACT_PATHS, censor: '[redacted]' },

    // In production, one JSON object per line for whatever collects them.
    // In development, human-readable without pulling in pino-pretty as a
    // dependency the production image would also carry.
    ...(config.isProduction
      ? {}
      : {
          transport: {
            target: 'pino/file',
            options: { destination: 1 },
          },
        }),

    serializers: {
      /**
       * Deliberately minimal. `url` is the routed path (`/orders/:id`), never
       * the resolved one, so an order number never lands in a log line, and the
       * query string is dropped entirely — it is where emails arrive from
       * lookup forms.
       */
      req(request: {
        id: string;
        method: string;
        routeOptions?: { url?: string };
        url: string;
      }) {
        return {
          id: request.id,
          method: request.method,
          route: request.routeOptions?.url ?? redactPath(request.url),
        };
      },

      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },

      err: pino.stdSerializers.err,
    },
  });
}

/**
 * Fallback for a request that never matched a route (404s, scanners). Keeps the
 * shape of the path for debugging but drops anything that looks like an
 * identifier, since an unrouted URL is exactly where a scanner puts junk.
 */
function redactPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path
    .split('/')
    .map((segment) =>
      /^[0-9a-f-]{8,}$/i.test(segment) || /\d{4,}/.test(segment) ? ':id' : segment,
    )
    .join('/');
}

/** Request ids are random and meaningless: they correlate log lines, nothing else. */
export function requestIdFactory(): string {
  return randomUUID();
}
