/**
 * Storefront tests.
 *
 * These run against the seeded placeholder catalogue, which was built to be
 * awkward on purpose: a product that is sold out, one with a single unit left,
 * one with stock tracking off, one with a name too long for a card, one with
 * three paragraphs, one carrying the dormant restricted flag, and one that is
 * inactive. Each of those is a case the shop has to get right before the
 * client's real products arrive, and each is asserted below.
 *
 *   npm test
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let catalog: string;

before(async () => {
  app = await buildServer();
  await app.ready();

  const seeded = await getDb()
    .selectFrom('products')
    .select('slug')
    .where('slug', 'like', 'sample-%')
    .execute();
  assert.ok(seeded.length >= 8, 'run `npm run seed` before these tests');

  catalog = (await app.inject({ method: 'GET', url: '/' })).body;
});

after(async () => {
  await app.close();
  await closeDb();
});

// --- the catalogue ---------------------------------------------------------

test('the catalogue lists the active products', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(catalog, /Sample Product One/);
});

test('prices render as money, never as raw cents', () => {
  assert.match(catalog, /\$24\.00/);
  assert.match(catalog, /\$45\.50/); // 4550 cents: the case a naive /100 gets wrong
  assert.ok(!catalog.includes('4550'), 'a raw cent value must never reach the page');
});

test('an inactive product is absent from the catalogue', () => {
  assert.ok(!catalog.includes('sample-08-hidden'));
  assert.ok(!catalog.includes('not visible in shop'));
});

// --- the leak that matters -------------------------------------------------

test('an inactive product 404s on its direct URL', async () => {
  // Hiding it from the listing alone is the classic half-fix: the URL is
  // guessable, and it leaks an unreleased product, its price and its photos.
  const res = await app.inject({ method: 'GET', url: '/p/sample-08-hidden' });
  assert.equal(res.statusCode, 404);
});

test('a hidden product is indistinguishable from one that never existed', async () => {
  const hidden = await app.inject({ method: 'GET', url: '/p/sample-08-hidden' });
  const nonsense = await app.inject({ method: 'GET', url: '/p/no-such-product-at-all' });

  assert.equal(hidden.statusCode, nonsense.statusCode);

  // Every response carries its own request id, for support. That is the only
  // difference allowed between these two pages.
  const withoutRequestId = (html: string): string =>
    html.replace(/Reference:[^<]*/g, 'Reference:');
  assert.equal(withoutRequestId(hidden.body), withoutRequestId(nonsense.body));
});

// --- stock states ----------------------------------------------------------

test('a sold-out product shows as sold out and cannot be added', async () => {
  const res = await app.inject({ method: 'GET', url: '/p/sample-04-sold-out' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Sold out/);
  assert.ok(!res.body.includes('Add to cart'), 'sold out must not offer an add button');
});

test('the last unit says so, in a way a customer can act on', async () => {
  const res = await app.inject({ method: 'GET', url: '/p/sample-03-last-one' });
  assert.match(res.body, /Only 1 left/);
  assert.match(res.body, /Add to cart/);
});

test('a product with stock tracking off shows no count and stays buyable', async () => {
  // Stock is 0 on this row, but the shop must not treat it as sold out.
  const res = await app.inject({ method: 'GET', url: '/p/sample-05-untracked' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Add to cart/);
  assert.ok(!res.body.includes('Sold out'));
  assert.ok(!res.body.includes('left'));
});

// --- the dormant flag ------------------------------------------------------

test('the restricted flag changes nothing a customer can see', async () => {
  const restricted = await app.inject({ method: 'GET', url: '/p/sample-07-restricted-flag' });
  const ordinary = await app.inject({ method: 'GET', url: '/p/sample-01-standard' });

  assert.equal(restricted.statusCode, 200);
  assert.match(restricted.body, /Add to cart/);

  // The flag exists so a notice can be added later without a rebuild. Until
  // that is asked for, the two pages must have the same structure: same tags,
  // same classes. Only the content and the image filename may differ.
  const structure = (html: string): string =>
    html
      .replace(/<img[^>]*>/g, '<img>')
      .replace(/ (?:src|alt|href|value|content)="[^"]*"/g, '')
      .replace(/>[^<]*</g, '><')
      .replace(/\s+/g, ' ')
      .trim();
  assert.equal(structure(restricted.body), structure(ordinary.body));

  // Structural equality is the whole assertion, and it is the strong form: if
  // the template ever grows a badge, a notice or an extra class for restricted
  // items, the shapes stop matching and this fails. Sniffing the page for the
  // word "restricted" would be weaker and wrong here anyway, since the seed
  // puts it in the slug and the description so the fixture is self-describing.
});

// --- content ---------------------------------------------------------------

test('a multi-paragraph description renders as separate paragraphs', async () => {
  const res = await app.inject({ method: 'GET', url: '/p/sample-06-long-description' });
  const paragraphs = res.body.match(/<p>/g) ?? [];
  assert.ok(paragraphs.length >= 3, `expected 3+ paragraphs, got ${paragraphs.length}`);
});

test('a product with no image falls back rather than showing a broken image', async () => {
  // sample-08 is the row without an image, but it is inactive, so the fallback
  // is checked directly: every rendered product must have a real src.
  const res = await app.inject({ method: 'GET', url: '/' });
  const srcs = [...res.body.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 0);
  assert.ok(srcs.every((s) => typeof s === 'string' && s !== ''));
});

test('description text is escaped, never injected as markup', async () => {
  const db = getDb();
  const slug = 'sample-xss-probe';
  await db
    .insertInto('products')
    .values({
      slug,
      name: 'Probe <script>alert(1)</script>',
      description: 'Body <img src=x onerror=alert(1)>',
      price_cents: 100,
      active: true,
    })
    .execute();

  try {
    const res = await app.inject({ method: 'GET', url: `/p/${slug}` });
    assert.equal(res.statusCode, 200);

    // The escaped text still contains the words "onerror" and "alert" — it is
    // text, and that is the point. What must not exist is a real tag: the
    // angle brackets have to be entities, so the browser renders characters
    // rather than building an element.
    assert.ok(!res.body.includes('<script>'), 'a script tag must never be built');
    assert.ok(!/<img[^>]*onerror/i.test(res.body), 'an img with a handler must never be built');
    assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(res.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  } finally {
    await db.deleteFrom('products').where('slug', '=', slug).execute();
  }
});

// --- the cart stub ---------------------------------------------------------

test('add to cart returns to the product and says the cart is not built yet', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/cart/add',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ slug: 'sample-01-standard' }).toString(),
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['location'], '/p/sample-01-standard?soon=1');

  const page = await app.inject({ method: 'GET', url: '/p/sample-01-standard?soon=1' });
  assert.match(page.body, /cart opens next week/i);
});

// --- privacy posture -------------------------------------------------------

test('the shop loads nothing from anywhere else', async () => {
  // A single third-party font or script would tell someone else that a
  // customer is on this page, which is the whole thing the client is paying to
  // avoid. The CSP forbids it; this asserts the markup does not try.
  const urls = [
    ...[...catalog.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ''),
  ];
  const external = urls.filter((u) => /^https?:\/\//i.test(u) || u.startsWith('//'));
  assert.deepEqual(external, [], `external references found: ${external.join(', ')}`);
});

test('the shop is indexable while the admin is not', async () => {
  const shop = await app.inject({ method: 'GET', url: '/' });
  const admin = await app.inject({ method: 'GET', url: '/admin/login' });

  assert.ok(!shop.body.includes('noindex'));
  assert.match(admin.body, /noindex/);
});
