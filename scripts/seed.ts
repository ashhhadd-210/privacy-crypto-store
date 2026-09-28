/**
 * Placeholder catalogue seed.
 *
 * The client owns product content and photography (chat, 19 Sep: "Not included:
 * content and product photos"), so the storefront is built against these eight
 * placeholders and the real catalogue drops in later through the admin.
 *
 *   npm run seed          insert the placeholder catalogue
 *   npm run seed -- --reset   delete the placeholders first, then re-insert
 *
 * The rows are chosen to be awkward on purpose. Real catalogues have a product
 * with no stock, a product with one left, a name too long for one line, a
 * description of two words and a description of two paragraphs. Building the
 * catalog and product pages against tidy sample data is how you end up with a
 * layout that breaks the first time the client saves a real product.
 *
 * Every row is marked with `PLACEHOLDER_PREFIX` in its slug, so `--reset`
 * removes exactly these and never touches anything the client has entered.
 */

import 'dotenv/config';
import { Client } from 'pg';

const PLACEHOLDER_PREFIX = 'sample-';

type Seed = {
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  stock: number;
  track_stock: boolean;
  active: boolean;
  restricted_item: boolean;
  image: string | null;
  extraImages?: string[];
};

const PRODUCTS: Seed[] = [
  {
    slug: 'sample-01-standard',
    name: 'Sample Product One',
    description:
      'A short description. Some products will only ever have one line, and the product page has to look deliberate when that happens rather than leaving a hole under the price.',
    price_cents: 2400,
    stock: 25,
    track_stock: true,
    active: true,
    restricted_item: false,
    image: 'placeholder/product-01.svg',
  },
  {
    slug: 'sample-02-long-name',
    name: 'Sample Product Two — Extended Edition With A Deliberately Long Name',
    description:
      'This one exists to break the catalogue grid. If the card layout only works with short names, a client who types a long one will find out before we do.',
    price_cents: 4550,
    stock: 8,
    track_stock: true,
    active: true,
    restricted_item: false,
    image: 'placeholder/product-02.svg',
  },
  {
    slug: 'sample-03-last-one',
    name: 'Sample Product Three',
    description:
      'Stock of one. The cart has to stop a second customer adding it, and the product page should say so plainly rather than letting somebody reach checkout and fail there.',
    price_cents: 1200,
    stock: 1,
    track_stock: true,
    active: true,
    restricted_item: false,
    image: 'placeholder/product-03.svg',
  },
  {
    slug: 'sample-04-sold-out',
    name: 'Sample Product Four',
    description:
      'Out of stock. It still has a page, it still ranks, and it still tells the visitor when it is worth coming back. What it must not have is a working add-to-cart button.',
    price_cents: 3999,
    stock: 0,
    track_stock: true,
    active: true,
    restricted_item: false,
    image: 'placeholder/product-04.svg',
  },
  {
    slug: 'sample-05-untracked',
    name: 'Sample Product Five',
    description:
      'Stock tracking is off for this one, which is how a made-to-order or unlimited item behaves. It should never show a stock count and never block a purchase.',
    price_cents: 7550,
    stock: 0,
    track_stock: false,
    active: true,
    restricted_item: false,
    image: 'placeholder/product-05.svg',
  },
  {
    slug: 'sample-06-long-description',
    name: 'Sample Product Six',
    description:
      'Some products come with a wall of text, and the product page has to stay readable when they do.\n\n' +
      'This paragraph is the second one, which is the actual test: line length, spacing between paragraphs, and whether the add-to-cart button is still reachable without scrolling past the fold on a phone. ' +
      'A description field that only looks right at fifty words is a field the client will fight with every time they add a product.\n\n' +
      'The third paragraph exists so the page has to handle three.',
    price_cents: 9900,
    stock: 14,
    track_stock: true,
    active: true,
    restricted_item: false,
    image: 'placeholder/product-06.svg',
    // Three views, so the product page gallery has something to switch between.
    extraImages: ['placeholder/product-06-b.svg', 'placeholder/product-06-c.svg'],
  },
  {
    slug: 'sample-07-restricted-flag',
    name: 'Sample Product Seven',
    description:
      'This row carries the dormant restricted-item flag. It must behave exactly like every other product: the flag exists so that adding a notice later is a small change, not a rebuild. If this product looks or behaves differently anywhere, that is a bug.',
    price_cents: 12500,
    stock: 6,
    track_stock: true,
    active: true,
    restricted_item: true,
    image: 'placeholder/product-07.svg',
  },
  {
    slug: 'sample-08-hidden',
    name: 'Sample Product Eight (not visible in shop)',
    description:
      'Inactive. It must be absent from the catalogue and its direct URL must not serve a page, or an unreleased product leaks the moment somebody guesses a slug. Visible in the admin only.',
    price_cents: 18000,
    stock: 30,
    track_stock: true,
    active: false,
    restricted_item: false,
    image: null, // also covers the no-image fallback path
  },
];

function fail(message: string): never {
  console.error(`seed: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) fail('DATABASE_URL is not set (copy .env.example to .env)');

  if (process.env['NODE_ENV'] === 'production' && !process.argv.includes('--force')) {
    fail('refusing to seed placeholder products in production (pass --force if you really mean it)');
  }

  const reset = process.argv.includes('--reset');
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (err) {
    fail(`cannot connect to the database: ${(err as Error).message}`);
  }

  try {
    await client.query('BEGIN');

    if (reset) {
      const { rowCount } = await client.query('DELETE FROM products WHERE slug LIKE $1', [
        `${PLACEHOLDER_PREFIX}%`,
      ]);
      console.log(`removed ${rowCount ?? 0} existing placeholder product(s)`);
    }

    let inserted = 0;
    let skipped = 0;

    for (const [index, p] of PRODUCTS.entries()) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO products
           (slug, name, description, price_cents, stock, track_stock, active, restricted_item, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [
          p.slug,
          p.name,
          p.description,
          p.price_cents,
          p.stock,
          p.track_stock,
          p.active,
          p.restricted_item,
          index + 1,
        ],
      );

      const id = rows[0]?.id;
      if (id === undefined) {
        skipped++;
        continue;
      }

      const images = p.image === null ? [] : [p.image, ...(p.extraImages ?? [])];
      for (const [i, path] of images.entries()) {
        await client.query(
          `INSERT INTO product_images (product_id, path, alt, sort_order) VALUES ($1, $2, $3, $4)`,
          [id, path, images.length > 1 ? `Placeholder image ${i + 1} of ${images.length} for ${p.name}` : `Placeholder image for ${p.name}`, i + 1],
        );
      }

      inserted++;
    }

    await client.query(
      `INSERT INTO promotions (code, type, value, min_subtotal_cents, max_uses, active)
       VALUES ('SAMPLE10', 'percent', 10, 0, 100, TRUE)
       ON CONFLICT (code) DO NOTHING`,
    );

    await client.query('COMMIT');

    console.log(`inserted ${inserted} product(s), skipped ${skipped} already present`);
    console.log("promotion code SAMPLE10 (10% off) available for checkout testing");
    if (skipped > 0 && !reset) console.log('run with --reset to replace the existing placeholders');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail((err as Error).message);
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
