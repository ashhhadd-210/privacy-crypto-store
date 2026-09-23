/**
 * Route and security tests.
 *
 * These run against a real Fastify instance via `app.inject()` — no network, no
 * port, but the whole plugin chain: helmet, cookies, CSRF, rate limiting, the
 * view engine and the error handler. A test that stubs those out would pass
 * while the running server did something else entirely, which is exactly what
 * happened twice while this file was being written:
 *
 *   1. CSRF protection was registered but never attached to a route, so a POST
 *      with no token logged in successfully.
 *   2. Once attached, it was attached at `onRequest`, which runs before the
 *      body is parsed, so a token in a form field was invisible and every
 *      request was rejected — protection that looked correct and broke login.
 *
 * Both are now asserted below, in both directions.
 *
 *   npm test
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { hashPassword } from '../lib/session.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const EMAIL = `test-admin-${randomBytes(4).toString('hex')}@example.com`;
const PASSWORD = 'correct horse battery staple 9134';

let app: App;

before(async () => {
  app = await buildServer();
  await app.ready();

  await getDb()
    .insertInto('admin_users')
    .values({
      email: EMAIL,
      password_hash: await hashPassword(PASSWORD),
      totp_secret: null,
      locked_until: null,
      last_login_at: null,
    })
    .execute();
});

after(async () => {
  await getDb().deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

/**
 * Each test gets its own source IP. The login route is rate limited to 5
 * attempts per 10 minutes per IP, which is correct in production and would
 * otherwise make every test after the fifth fail with 429 — a real effect that
 * cost two confusing failures before it was understood. trustProxy is on, so
 * X-Forwarded-For is what the limiter keys on, exactly as it will behind Caddy.
 */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

/** Fetches the login form and returns its CSRF token plus the cookie to send back. */
async function getCsrf(ip: string): Promise<{ token: string; cookie: string }> {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/login',
    headers: { 'x-forwarded-for': ip },
  });
  const token = /name="_csrf" value="([^"]+)"/.exec(res.body)?.[1];
  assert.ok(token, 'login form must carry a CSRF token');

  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const secret = /_csrf=([^;]+)/.exec(raw)?.[1];
  assert.ok(secret, 'login form must set the CSRF cookie');

  return { token, cookie: `_csrf=${secret}` };
}

function login(fields: Record<string, string>, cookie: string, ip: string) {
  return app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      'x-forwarded-for': ip,
    },
    payload: new URLSearchParams(fields).toString(),
  });
}

// --- health ----------------------------------------------------------------

test('liveness does not depend on the database', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('readiness reports the database', async () => {
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ready' });
});

// --- headers ---------------------------------------------------------------

test('security headers are present on an HTML response', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/login' });
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');

  const csp = String(res.headers['content-security-policy']);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('unsafe-inline'), 'CSP must not allow inline script or style');
});

// --- access control --------------------------------------------------------

test('the admin area redirects to login when signed out', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers['location'], '/admin/login');
});

// --- CSRF ------------------------------------------------------------------

test('a POST with no CSRF token is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() },
    payload: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
  });
  assert.equal(res.statusCode, 403);
});

test('a POST with a forged CSRF token is refused', async () => {
  const ip = nextIp();
  const { cookie } = await getCsrf(ip);
  const res = await login({ _csrf: 'not-a-real-token', email: EMAIL, password: PASSWORD }, cookie, ip);
  assert.equal(res.statusCode, 403);
});

test('a POST with a valid CSRF token is accepted', async () => {
  // The other half of the guarantee: protection that rejects everything,
  // including legitimate requests, is a broken login page, not a secure one.
  const ip = nextIp();
  const { token, cookie } = await getCsrf(ip);
  const res = await login({ _csrf: token, email: EMAIL, password: PASSWORD }, cookie, ip);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers['location'], '/admin');
});

// --- authentication --------------------------------------------------------

test('a wrong password is rejected', async () => {
  const ip = nextIp();
  const { token, cookie } = await getCsrf(ip);
  const res = await login({ _csrf: token, email: EMAIL, password: 'wrong' }, cookie, ip);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Those details are not correct/);
});

test('an unknown account gives the identical message', async () => {
  // Anything else is an account enumeration oracle.
  const ip = nextIp();
  const { token, cookie } = await getCsrf(ip);
  const res = await login(
    { _csrf: token, email: 'nobody@example.com', password: 'wrong' },
    cookie,
    ip,
  );
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Those details are not correct/);
});

test('a successful login sets an httpOnly, SameSite=Strict session cookie', async () => {
  const ip = nextIp();
  const { token, cookie } = await getCsrf(ip);
  const res = await login({ _csrf: token, email: EMAIL, password: PASSWORD }, cookie, ip);

  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie ?? '');
  const line = raw.split('\n').find((c) => c.startsWith('admin_session='));

  assert.ok(line, 'a session cookie must be set');
  assert.match(line, /HttpOnly/i);
  assert.match(line, /SameSite=Strict/i);
  assert.match(line, /Path=\/admin/i);
});

test('the session id is stored as a hash, never as the cookie value', async () => {
  const ip = nextIp();
  const { token, cookie } = await getCsrf(ip);
  const res = await login({ _csrf: token, email: EMAIL, password: PASSWORD }, cookie, ip);

  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie ?? '');
  const value = /admin_session=([^;]+)/.exec(raw)?.[1];
  assert.ok(value);

  const rows = await getDb().selectFrom('admin_sessions').select('id').execute();
  assert.ok(rows.length > 0);
  // The raw cookie must not appear anywhere in the table: a stolen database
  // must not hand over replayable sessions.
  assert.ok(!rows.some((r) => r.id === value));
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.id)));
});

// --- rate limiting ---------------------------------------------------------

test('repeated attempts from one address are rate limited', async () => {
  // The per-IP limiter is the first line; the per-account lockout in
  // session.ts is the second, for attempts spread across many addresses.
  const ip = nextIp();
  const codes: number[] = [];

  for (let i = 0; i < 7; i++) {
    const { token, cookie } = await getCsrf(ip);
    const res = await login({ _csrf: token, email: EMAIL, password: 'wrong' }, cookie, ip);
    codes.push(res.statusCode);
  }

  assert.ok(codes.includes(429), `expected a 429 among ${codes.join(', ')}`);
  assert.equal(codes[0], 401, 'the first attempt should be judged on its merits');
});

// --- error handling --------------------------------------------------------

test('a 404 reveals nothing about the application', async () => {
  const res = await app.inject({ method: 'GET', url: '/nope/../secret' });
  assert.equal(res.statusCode, 404);
  assert.ok(!/stack|at Object|node_modules|\.ts:/i.test(res.body));
});
