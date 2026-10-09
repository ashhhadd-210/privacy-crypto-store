/**
 * Light and dark mode: dark by default, the choice survives in a one-word
 * cookie, and the "send me back" path can never point at another site.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../server.js';
import { closeDb } from '../lib/db.js';
import { safeBack } from './theme.js';

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  await closeDb();
});

test('the shop is dark by default and offers light mode', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.match(res.body, /<html lang="en" data-theme="dark">/);
  assert.match(res.body, /href="\/theme\/light\?back=%2F"/);
});

test('choosing light sets a preference cookie and returns to the page', async () => {
  const res = await app.inject({ method: 'GET', url: '/theme/light?back=%2Fcart%3Fmsg%3Dadded' });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], '/cart?msg=added');
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /^theme=light;/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('the light cookie renders the light page with a way back to dark', async () => {
  const res = await app.inject({ method: 'GET', url: '/', cookies: { theme: 'light' } });
  assert.match(res.body, /data-theme="light"/);
  assert.match(res.body, /href="\/theme\/dark\?back=%2F"/);
});

test('anything other than "light" in the cookie means dark', async () => {
  const res = await app.inject({ method: 'GET', url: '/', cookies: { theme: '"><script>alert(1)</script>' } });
  assert.match(res.body, /data-theme="dark"/);
  assert.ok(!res.body.includes('<script>alert(1)'));
});

test('an unknown mode is a 404 and sets nothing', async () => {
  const res = await app.inject({ method: 'GET', url: '/theme/purple' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('the return path never leaves the site', async () => {
  for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', '', 'x'.repeat(600)]) {
    assert.equal(safeBack(bad), '/', bad);
  }
  assert.equal(safeBack('/p/some-product?img=2'), '/p/some-product?img=2');
  const res = await app.inject({ method: 'GET', url: '/theme/dark?back=%2F%2Fevil.example' });
  assert.equal(res.headers['location'], '/');
});
