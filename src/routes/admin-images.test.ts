/**
 * Product photo tests: the processing on its own (metadata really removed,
 * dangerous formats refused), then uploads through a signed-in admin.
 *
 *   npm test
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';
import { ImageRejected, UPLOAD_DIR, deleteStoredImage, processProductImage } from '../lib/images.js';
import { hashPassword } from '../lib/session.js';
import { Visitor } from '../test/visitor.js';

type App = Awaited<ReturnType<typeof buildServer>>;

const RUN = randomBytes(4).toString('hex');
const EMAIL = `admin-images-${RUN}@example.com`;
const PASSWORD = 'correct horse battery staple 8813';
const SECRET_TAG = `Home of the owner ${RUN}`;

/** A photo like a phone takes: camera details, the owner's name, and a GPS position. */
async function phonePhoto(width = 1600, height = 1200, orientation?: number): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } } });
  return (orientation ? base.withMetadata({ orientation }) : base)
    .jpeg()
    .withExifMerge({
      IFD0: { Make: 'ProbeCam', Model: 'ProbeCam X1', Artist: SECRET_TAG, Copyright: SECRET_TAG },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' },
    })
    .toBuffer();
}

let app: App;
let admin: Visitor;
let productId: string;

before(async () => {
  app = await buildServer();
  await app.ready();
  const db = getDb();
  await db.insertInto('admin_users').values({ email: EMAIL, password_hash: await hashPassword(PASSWORD), totp_secret: null }).execute();
  const p = await db
    .insertInto('products')
    .values({ slug: `img-probe-${RUN}`, name: `Image Probe ${RUN}`, price_cents: 1000, active: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  productId = p.id;
});

after(async () => {
  const db = getDb();
  const images = await db.selectFrom('product_images').select('path').where('product_id', '=', productId).execute();
  for (const i of images) await deleteStoredImage(i.path);
  await db.deleteFrom('products').where('id', '=', productId).execute();
  await db.deleteFrom('audit_log').where('actor', '=', EMAIL).execute();
  await db.deleteFrom('admin_users').where('email', '=', EMAIL).execute();
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  admin = new Visitor(app, `/admin/products/${productId}`);
  const login = new Visitor(app, '/admin/login');
  login.ip = admin.ip;
  const res = await login.post('/admin/login', { email: EMAIL, password: PASSWORD });
  assert.equal(res.headers['location'], '/admin');
  admin.jar = login.jar;
});

/** A real multipart/form-data upload, as a browser sends it. */
async function upload(file: Buffer, filename: string, type: string, opts: { csrf?: boolean; alt?: string } = {}) {
  const boundary = `----probe${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  const field = (name: string, value: string) =>
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  if (opts.csrf !== false) field('_csrf', await admin.token());
  if (opts.alt !== undefined) field('alt', opts.alt);
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return app.inject({
    method: 'POST',
    url: `/admin/products/${productId}/images`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: admin.cookieHeader(), 'x-forwarded-for': admin.ip },
    payload: Buffer.concat(parts),
  });
}

const photosOf = () =>
  getDb().selectFrom('product_images').select(['id', 'path', 'alt', 'sort_order']).where('product_id', '=', productId).orderBy('sort_order').execute();

// --- processing on its own -------------------------------------------------

test('the test photo really does carry GPS and the owner name, before processing', async () => {
  const meta = await sharp(await phonePhoto()).metadata();
  assert.ok(meta.exif && meta.exif.includes(Buffer.from(SECRET_TAG)), 'fixture must contain the secret');
});

test('processing removes every trace of camera, owner and location', async () => {
  const out = await processProductImage(await phonePhoto());
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.exif, undefined, 'no EXIF block');
  assert.equal(meta.xmp, undefined, 'no XMP block');
  assert.ok(!out.includes(Buffer.from(SECRET_TAG)), 'owner name gone from the bytes');
  assert.ok(!out.includes(Buffer.from('ProbeCam')), 'camera gone from the bytes');
});

test('large photos are scaled down to 1200 pixels, small ones are left alone', async () => {
  const big = await sharp(await processProductImage(await phonePhoto(3000, 2000))).metadata();
  assert.deepEqual([big.width, big.height], [1200, 800]);
  const small = await sharp(await processProductImage(await phonePhoto(640, 480))).metadata();
  assert.deepEqual([small.width, small.height], [640, 480]);
});

test('a photo taken sideways is turned the right way up before its metadata is dropped', async () => {
  // Orientation 6: the camera stored it landscape and asked viewers to rotate 90 degrees.
  const input = await phonePhoto(400, 200, 6);
  assert.equal((await sharp(input).metadata()).orientation, 6, 'fixture carries the rotation flag');
  const out = await sharp(await processProductImage(input)).metadata();
  assert.deepEqual([out.width, out.height], [200, 400]);
});

test('SVG, GIF and files that are not images are refused', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).gif().toBuffer();
  for (const [name, file] of [['svg', svg], ['gif', gif], ['text', Buffer.from('just some text')], ['empty', Buffer.alloc(0)]] as const) {
    await assert.rejects(processProductImage(file), ImageRejected, name);
  }
});

test('an image with an absurd pixel count is refused before it is decoded', async () => {
  // Tiny file, 60 megapixels: the classic decompression bomb.
  const bomb = await sharp({ create: { width: 10_000, height: 6_000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 2 * 1024 * 1024, 'the bomb is small on disk');
  await assert.rejects(processProductImage(bomb), ImageRejected);
});

// --- through the admin -----------------------------------------------------

test('an uploaded photo is stored clean, under a random name, and shown in the shop', async () => {
  const res = await upload(await phonePhoto(), 'IMG_0042.jpg', 'image/jpeg', { alt: 'The mug from the front' });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], `/admin/products/${productId}?photo=added#photos`);

  const [photo] = await photosOf();
  assert.ok(photo);
  assert.match(photo.path, /^uploads\/[0-9a-f]{32}\.webp$/, 'random name, never the uploaded filename');
  assert.equal(photo.alt, 'The mug from the front');

  const stored = await readFile(join(UPLOAD_DIR, photo.path.slice('uploads/'.length)));
  assert.equal((await sharp(stored).metadata()).exif, undefined);
  assert.ok(!stored.includes(Buffer.from(SECRET_TAG)));

  const shop = await app.inject({ method: 'GET', url: `/p/img-probe-${RUN}` });
  assert.match(shop.body, new RegExp(`src="/${photo.path}"`));
  const served = await app.inject({ method: 'GET', url: `/${photo.path}` });
  assert.equal(served.statusCode, 200);
  assert.match(String(served.headers['content-type']), /image\/webp/);
});

test('a photo with no description is described by the product name', async () => {
  await upload(await phonePhoto(), 'x.jpg', 'image/jpeg');
  const photos = await photosOf();
  assert.equal(photos.at(-1)?.alt, `Image Probe ${RUN}`);
});

test('an SVG upload is refused with a plain explanation, and nothing is stored', async () => {
  const before = (await photosOf()).length;
  const res = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml');
  assert.equal(res.headers['location'], `/admin/products/${productId}?photo=type#photos`);
  assert.equal((await photosOf()).length, before);
  const page = await admin.get(`/admin/products/${productId}?photo=type`);
  assert.match(page.body, /Use a JPEG, PNG or WebP photo/);
});

test('a file over 10 MB is refused with a plain explanation', async () => {
  const res = await upload(Buffer.alloc(10 * 1024 * 1024 + 1, 0xff), 'huge.jpg', 'image/jpeg');
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], `/admin/products/${productId}?photo=too-big#photos`);
});

test('uploading needs a CSRF token', async () => {
  const res = await upload(await phonePhoto(), 'x.jpg', 'image/jpeg', { csrf: false });
  assert.equal(res.statusCode, 403);
});

test('only this route accepts uploads: multipart anywhere else is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/cart/add',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    payload: '--x\r\nContent-Disposition: form-data; name="slug"\r\n\r\nsample\r\n--x--\r\n',
  });
  assert.equal(res.statusCode, 415);
});

test('making a photo the main one puts it first in the shop', async () => {
  await upload(await phonePhoto(), 'a.jpg', 'image/jpeg');
  await upload(await phonePhoto(), 'b.jpg', 'image/jpeg');
  const photos = await photosOf();
  const last = photos.at(-1);
  assert.ok(last);
  const res = await admin.post(`/admin/products/${productId}/images/${last.id}/main`, {});
  assert.equal(res.headers['location'], `/admin/products/${productId}?photo=main#photos`);
  assert.equal((await photosOf())[0]?.id, last.id);
  const shop = await app.inject({ method: 'GET', url: `/p/img-probe-${RUN}` });
  assert.match(shop.body, new RegExp(`<div class="detail-image[^"]*">\\s*<img src="/${last.path}"`));
});

test('removing a photo deletes the file too', async () => {
  await upload(await phonePhoto(), 'gone.jpg', 'image/jpeg');
  const photo = (await photosOf()).at(-1);
  assert.ok(photo);
  const file = join(UPLOAD_DIR, photo.path.slice('uploads/'.length));
  await stat(file);
  const res = await admin.post(`/admin/products/${productId}/images/${photo.id}/delete`, {});
  assert.equal(res.headers['location'], `/admin/products/${productId}?photo=removed#photos`);
  await assert.rejects(stat(file), /ENOENT/);
});

test('photo changes are recorded in the audit log', async () => {
  const actions = await getDb().selectFrom('audit_log').select('action').where('actor', '=', EMAIL).where('entity_id', '=', productId).execute();
  const set = new Set(actions.map((a) => a.action));
  for (const a of ['product.image.add', 'product.image.main', 'product.image.remove']) assert.ok(set.has(a), a);
});
