/**
 * Admin routes: login, logout, and the guard every other admin route will sit
 * behind from week 3 onward.
 *
 * The panel is additionally gated at the edge (Cloudflare Access or an IP rule,
 * open question #16), but nothing here assumes that gate exists. Defence in
 * depth means this has to hold on its own.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { loadConfig } from '../lib/config.js';
import { getDb } from '../lib/db.js';
import {
  createSession,
  destroySession,
  resolveSession,
  verifyLogin,
  type SessionUser,
} from '../lib/session.js';

const SESSION_COOKIE = 'admin_session';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: SessionUser;
  }
}

function cookieOptions(expires?: Date) {
  const config = loadConfig();
  return {
    httpOnly: true, // not readable by script, so an XSS cannot steal the session
    secure: config.isProduction, // https only in production; plain http locally
    sameSite: 'strict' as const, // the admin panel is never linked to from elsewhere
    path: '/admin',
    ...(expires ? { expires } : {}),
  };
}

/**
 * Route guard. Attaches the admin to the request or redirects to the login
 * page. Registered as a preHandler on every admin route except login itself.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  const user = await resolveSession(token);

  if (user === null) {
    return reply.redirect('/admin/login');
  }

  request.adminUser = user;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/admin/login', async (request, reply) => {
    // Already signed in? Don't show the form again.
    if (await resolveSession(request.cookies[SESSION_COOKIE])) {
      return reply.redirect('/admin');
    }
    return reply.view('admin/login.njk', { csrfToken: reply.generateCsrf() });
  });

  app.post<{ Body: { email?: string; password?: string } }>(
    '/admin/login',
    {
      // Two things about this line, both of which were bugs first.
      //
      // Registering @fastify/csrf-protection does NOT protect anything on its
      // own: it only decorates the instance. A route that forgets to attach the
      // check has no CSRF protection while looking protected from the plugin
      // list alone.
      //
      // And it must be preValidation, not onRequest: onRequest runs before the
      // body is parsed, so a token carried in a form field is not visible yet
      // and every request is rejected — which looks like working protection
      // until a legitimate login also fails.
      preValidation: app.csrfProtection,
      // Tight limit: a human logs in a few times a day. Anything faster is not
      // a human. The per-account lockout in session.ts covers the distributed
      // case where the attempts come from many addresses.
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const email = request.body?.email ?? '';
      const password = request.body?.password ?? '';

      if (email === '' || password === '') {
        return reply.code(400).view('admin/login.njk', {
          csrfToken: reply.generateCsrf(),
          error: 'Enter your email and password.',
        });
      }

      const result = await verifyLogin(email, password);

      if (!result.ok) {
        // One message for both cases. Telling the visitor which of the two was
        // wrong hands an attacker a list of valid admin addresses.
        const message =
          result.reason === 'locked'
            ? 'Too many failed attempts. Try again later.'
            : 'Those details are not correct.';

        // The log records that a login failed and why, never who was tried.
        request.log.warn({ outcome: result.reason }, 'admin login rejected');

        return reply.code(401).view('admin/login.njk', {
          csrfToken: reply.generateCsrf(),
          error: message,
        });
      }

      const { token, expiresAt } = await createSession(
        result.user.id,
        request.ip,
        request.headers['user-agent'],
      );

      await db
        .insertInto('audit_log')
        .values({ actor: result.user.email, action: 'admin.login', entity: null, entity_id: null })
        .execute();

      request.log.info('admin login succeeded');

      return reply
        .setCookie(SESSION_COOKIE, token, cookieOptions(expiresAt))
        .redirect('/admin');
    },
  );

  app.post('/admin/logout', { preValidation: app.csrfProtection, preHandler: requireAdmin }, async (request, reply) => {
    await destroySession(request.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, cookieOptions()).redirect('/admin/login');
  });

  /**
   * Placeholder dashboard. Products, orders and settings land here in week 3;
   * today it exists to prove the session guard works end to end.
   */
  app.get('/admin', { preHandler: requireAdmin }, async (request, reply) => {
    const { count: productCount } = await db
      .selectFrom('products')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    return reply.view('admin/dashboard.njk', {
      email: request.adminUser?.email,
      productCount,
      csrfToken: reply.generateCsrf(),
    });
  });
}
