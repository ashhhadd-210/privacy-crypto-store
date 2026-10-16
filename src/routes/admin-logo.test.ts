/**
 * The owner's logo upload: the logo replaces the placeholder in the shop and
 * admin, removing it brings the placeholder back, only images are accepted,
 * nothing hidden in the file survives, and only a signed-in admin with a valid
 * form token can change it.
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { PUBLIC_DIR } from '../lib/paths.js';
import { getSettings, invalidateSettings, saveSettings } from '../lib/settings.js';
import { hashPassword } from '../lib/session.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;
const RUN = randomBytes(4).toString('hex');
const EMAIL = `admin-logo-${RUN}@example.com`;
const PASSWORD = 'correct horse battery staple logo';
const SECRET_TAG = `logo-owner-${RUN}`;
let app: App;
let admin: Visitor;
let original = '';

/** A wide PNG with transparency and a comment that must not survive. */
const logoPng = () =>
  sharp({ create: { width: 600, height: 150, channels: 4, background: { r: 20, g: 160, b: 90, alpha: 0.6 } } })
    .png()
    .withMetadata({ exif: { IFD0: { Artist: SECRET_TAG } } })
    .toBuffer();

async function upload(file: Buffer, filename: string, type: string, opts: { csrf?: boolean; who?: Visitor } = {}) {
  const who = opts.who ?? admin;
  const boundary = `----logo${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  if (opts.csrf !== false) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${await who.token()}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return app.inject({
    method: 'POST',
    url: '/admin/settings/logo',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: who.cookieHeader(), 'x-forwarded-for': who.ip },
    payload: Buffer.concat(parts),
  });
}

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  original = (await getSettings(db)).logo_path;
  await db.insertInto('admin_users').values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null }).execute();
});

after(async () => {
  const db = getDb();
  await saveSettings(db, { logo_path: original });
  invalidateSettings();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, '/admin/settings');
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  assert.equal((await login.post('/admin/login', { email: EMAIL, password: PASSWORD })).headers['location'], '/admin');
  admin.jar = login.jar;
});

test('an uploaded logo replaces the placeholder in the shop and the admin', async () => {
  const res = await upload(await logoPng(), 'logo.png', 'image/png');
  assert.equal(res.headers['location'], '/admin/settings?logo=added#logo');
  invalidateSettings();
  const path = (await getSettings()).logo_path;
  assert.match(path, /^uploads\/[0-9a-f]{32}\.webp$/);

  const shop = await app.inject({ method: 'GET', url: '/' });
  assert.match(shop.body, new RegExp(`class="brand-logo" src="/${path}"`));
  assert.ok(!shop.body.includes('src="/placeholder/logo.svg"'), 'no placeholder left on the page');
  const settings = await admin.get('/admin/settings?logo=added');
  assert.match(settings.body, /Logo updated/);
  assert.match(settings.body, new RegExp(`src="/${path}"`));

  const stored = await readFile(join(PUBLIC_DIR, path));
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.hasAlpha, true, 'transparency is kept');
  assert.equal(meta.exif, undefined, 'nothing hidden in the upload survives');
  assert.ok(!stored.includes(Buffer.from(SECRET_TAG)));
});

test('a new logo replaces the old file, and removing it brings the placeholder back', async () => {
  await upload(await logoPng(), 'first.png', 'image/png');
  invalidateSettings();
  const first = (await getSettings()).logo_path;
  await upload(await logoPng(), 'second.png', 'image/png');
  invalidateSettings();
  const second = (await getSettings()).logo_path;
  assert.notEqual(second, first);
  await assert.rejects(stat(join(PUBLIC_DIR, first)), 'the replaced logo file is deleted');

  assert.equal((await admin.post('/admin/settings/logo/remove', {})).headers['location'], '/admin/settings?logo=removed#logo');
  invalidateSettings();
  assert.equal((await getSettings()).logo_path, '');
  await assert.rejects(stat(join(PUBLIC_DIR, second)), 'the removed logo file is deleted');
  const shop = await app.inject({ method: 'GET', url: '/' });
  assert.match(shop.body, /class="brand-logo" src="\/placeholder\/logo.svg"/);
});

test('only images are accepted, never SVG or anything else', async () => {
  invalidateSettings();
  const before = (await getSettings()).logo_path;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const [file, name, type] of [
    [svg, 'logo.svg', 'image/svg+xml'],
    [Buffer.from('not an image at all'), 'logo.png', 'image/png'],
  ] as const) {
    assert.equal((await upload(file, name, type)).headers['location'], '/admin/settings?logo=type#logo', name);
  }
  invalidateSettings();
  assert.equal((await getSettings()).logo_path, before, 'nothing changed');
});

test('changing the logo needs a signed-in admin and a valid form token', async () => {
  assert.equal((await upload(await logoPng(), 'logo.png', 'image/png', { csrf: false })).statusCode, 403);
  const stranger = new Visitor(app, '/admin/login');
  const res = await upload(await logoPng(), 'logo.png', 'image/png', { who: stranger });
  assert.notEqual(res.headers['location'], '/admin/settings?logo=added#logo');
  assert.equal((await stranger.post('/admin/settings/logo/remove', {}, false)).statusCode, 403);
});
