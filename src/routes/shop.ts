/**
 * The storefront: catalogue and product pages.
 *
 * Two rules run through all of it.
 *
 * INACTIVE MEANS INVISIBLE. A product with `active = false` is absent from the
 * catalogue *and* its direct URL returns a 404 that is indistinguishable from a
 * slug that never existed. Half-doing this is the classic leak: the product is
 * hidden from the listing, and anyone who guesses the URL — or reads it from a
 * sitemap, a cached page or the admin's own browser history — sees the
 * unreleased product, its price and its photos.
 *
 * THE RESTRICTED FLAG CHANGES NOTHING. `products.restricted_item` exists
 * because the client was promised it at no cost, and it is deliberately inert.
 * Nothing in this file reads it. If a restricted product ever renders
 * differently from any other, that is a bug, and there is a test for it.
 */

import type { FastifyInstance } from 'fastify';

import { itemCount, readCart } from '../lib/cart.js';
import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';

/** What a template needs to render one product. No database shapes leak into views. */
interface ProductView {
  slug: string;
  name: string;
  description: string;
  price: string;
  image: string;
  imageAlt: string;
  /** Rendered as the stock line; null when stock is not tracked. */
  stockLabel: string | null;
  inStock: boolean;
}

const NO_IMAGE = '/placeholder/no-image.svg';

/**
 * Turns a stock count into something a customer can act on.
 *
 * "Only 1 left" is the case that matters: the cart has to refuse a second one,
 * and a customer who reaches checkout and is told no there will not come back.
 * Saying it on the product page is cheaper than handling it at checkout.
 */
function stockLabel(stock: number, trackStock: boolean): string | null {
  if (!trackStock) return null;
  if (stock <= 0) return 'Sold out';
  if (stock === 1) return 'Only 1 left';
  if (stock <= 5) return `Only ${stock} left`;
  return 'In stock';
}

function toView(
  row: {
    slug: string;
    name: string;
    description: string;
    price_cents: number;
    stock: number;
    track_stock: boolean;
  },
  image: { path: string; alt: string } | undefined,
): ProductView {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    price: formatMoney(row.price_cents),
    image: image === undefined ? NO_IMAGE : `/${image.path}`,
    imageAlt: image?.alt ?? '',
    stockLabel: stockLabel(row.stock, row.track_stock),
    inStock: !row.track_stock || row.stock > 0,
  };
}

/** Fetches the first image for each of the given products, in one query. */
export async function imagesFor(productIds: string[]): Promise<Map<string, { path: string; alt: string }>> {
  const byProduct = new Map<string, { path: string; alt: string }>();
  if (productIds.length === 0) return byProduct;

  const rows = await getDb()
    .selectFrom('product_images')
    .select(['product_id', 'path', 'alt', 'sort_order'])
    .where('product_id', 'in', productIds)
    .orderBy('sort_order')
    .execute();

  // First image wins; the rest are for the gallery in week 2.
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, { path: row.path, alt: row.alt });
    }
  }
  return byProduct;
}

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/', async (request, reply) => {
    const products = await db
      .selectFrom('products')
      .select(['id', 'slug', 'name', 'description', 'price_cents', 'stock', 'track_stock'])
      .where('active', '=', true)
      .orderBy('sort_order')
      .execute();

    const images = await imagesFor(products.map((p) => p.id));

    return reply.view('shop/catalog.njk', {
      title: 'Shop',
      bodyClass: 'shop',
      cartCount: itemCount(readCart(request)),
      products: products.map((p) => toView(p, images.get(p.id))),
    });
  });

  app.get<{ Params: { slug: string } }>('/p/:slug', async (request, reply) => {
    const product = await db
      .selectFrom('products')
      .select(['id', 'slug', 'name', 'description', 'price_cents', 'stock', 'track_stock'])
      .where('slug', '=', request.params.slug)
      // Part of the same query, not a check afterwards: an inactive product must
      // be indistinguishable from one that does not exist.
      .where('active', '=', true)
      .executeTakeFirst();

    if (product === undefined) {
      return reply.callNotFound();
    }

    const images = await imagesFor([product.id]);
    const view = toView(product, images.get(product.id));

    return reply.view('shop/product.njk', {
      title: product.name,
      bodyClass: 'shop',
      // Descriptions are authored as plain text with blank lines between
      // paragraphs. Split here rather than in the template so the view stays
      // free of logic, and never marked safe: nunjucks escapes every paragraph.
      paragraphs: product.description.split(/\n\s*\n/).filter((p) => p.trim() !== ''),
      product: view,
      cartCount: itemCount(readCart(request)),
      csrfToken: view.inStock ? reply.generateCsrf() : undefined,
    });
  });
}
