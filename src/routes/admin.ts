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
  hashPassword,
  resolveSession,
  tokenToId,
  verifyLogin,
  verifyPassword,
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

  /** What needs attention today. */
  app.get<{ Querystring: { password?: string } }>('/admin', { preHandler: requireAdmin }, async (request, reply) => {
    const statuses = await db
      .selectFrom('orders')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .groupBy('status')
      .execute();
    const n = (s: string) => Number(statuses.find((r) => r.status === s)?.n ?? 0);
    const lowStock = await db
      .selectFrom('products')
      .select(['id', 'name', 'stock'])
      .where('active', '=', true)
      .where('track_stock', '=', true)
      .where('stock', '<=', 2)
      .orderBy('stock')
      .limit(10)
      .execute();
    const attention = await db
      .selectFrom('payments')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', 'in', ['underpaid', 'overpaid'])
      .executeTakeFirstOrThrow();
    const lastPurge = await db.selectFrom('purge_runs').select(['ran_at', 'orders_purged', 'error']).orderBy('ran_at', 'desc').limit(1).executeTakeFirst();
    const { count: productCount } = await db
      .selectFrom('products')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();

    return reply.header('cache-control', 'no-store').view('admin/dashboard.njk', {
      title: 'Store administration',
      bodyClass: 'admin',
      email: request.adminUser?.email,
      productCount,
      toShip: n('paid'),
      awaiting: n('pending'),
      payIssues: Number(attention.n),
      lowStock,
      lastPurge: lastPurge && { when: lastPurge.ran_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC', orders: lastPurge.orders_purged, error: lastPurge.error },
      passwordChanged: request.query.password === 'changed',
      csrfToken: reply.generateCsrf(),
    });
  });

  // --- change own password -----------------------------------------------------
  app.get('/admin/password', { preHandler: requireAdmin }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').view('admin/password.njk', { title: 'Change password', bodyClass: 'admin', section: 'home', csrfToken: reply.generateCsrf() }),
  );

  app.post<{ Body: { current?: string; next?: string; confirm?: string } }>(
    '/admin/password',
    { preValidation: app.csrfProtection, preHandler: requireAdmin, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const fail = (error: string) =>
        reply.code(400).header('cache-control', 'no-store').view('admin/password.njk', { title: 'Change password', bodyClass: 'admin', section: 'home', csrfToken: reply.generateCsrf(), error });
      const { current = '', next = '', confirm = '' } = request.body ?? {};
      const me = request.adminUser as SessionUser;
      const row = await db.selectFrom('admin_users').select('password_hash').where('id', '=', me.id).executeTakeFirstOrThrow();
      if (!(await verifyPassword(row.password_hash, current))) return fail('Your current password is not correct.');
      if (next.length < 14 || next.length > 200) return fail('Use a new password of at least 14 characters.');
      if (next !== confirm) return fail('The two new passwords do not match.');
      if (next === current) return fail('Choose a password different from the current one.');

      await db.updateTable('admin_users').set({ password_hash: await hashPassword(next) }).where('id', '=', me.id).execute();
      // Every other session ends: if the old password was known to someone, they are out now.
      const token = request.cookies[SESSION_COOKIE];
      await db.deleteFrom('admin_sessions').where('user_id', '=', me.id).where('id', '!=', token ? tokenToId(token) : '').execute();
      await db.insertInto('audit_log').values({ actor: me.email, action: 'admin.password_change', entity: null, entity_id: null }).execute();
      return reply.redirect('/admin?password=changed', 303);
    },
  );
}
