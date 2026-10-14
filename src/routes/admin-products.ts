/**
 * Admin product management: list, add, edit.
 *
 * New products start hidden, so a half-entered product never appears in the
 * shop. There is no delete: hiding a product keeps its history intact, and
 * orders carry their own copy of the name and price regardless. Every change
 * is written to the audit log with the fields that changed; product data is
 * not personal data, so the log may keep it.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { FORM_FIELDS, type ProductForm, priceInput, productForm, slugify } from '../lib/product-form.js';
import { requireAdmin } from './admin.js';
import { PHOTO_MESSAGES } from './admin-images.js';
import { imagesFor } from './shop.js';
import { type PriceTier, type TierRow, parseTiers, tierRows, tiersFor } from '../lib/discounts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FormValues = Record<(typeof FORM_FIELDS)[number], string> & { track_stock: boolean; active: boolean };
type Errors = Partial<Record<(typeof FORM_FIELDS)[number] | 'tiers', string>>;

const EMPTY: FormValues = {
  name: '', slug: '', description: '', price: '', stock: '0', sort_order: '0', track_stock: true, active: false,
};

/** What the browser sent, as strings, so a failed save re-shows exactly what was typed. */
function echo(body: Record<string, unknown>): FormValues {
  const v = { ...EMPTY };
  for (const f of FORM_FIELDS) if (typeof body[f] === 'string') v[f] = (body[f] as string).slice(0, 10_000);
  v.track_stock = body['track_stock'] === 'on';
  v.active = body['active'] === 'on';
  return v;
}

function parse(body: Record<string, unknown>): { data: ProductForm } | { errors: Errors } {
  const result = productForm.safeParse({ ...body, track_stock: body['track_stock'] ?? '', active: body['active'] ?? '' });
  if (result.success) return { data: result.data };
  const errors: Errors = {};
  for (const issue of result.error.issues) {
    const f = issue.path[0];
    if (typeof f === 'string' && (FORM_FIELDS as readonly string[]).includes(f) && !(f in errors)) {
      errors[f as keyof Errors] = issue.message;
    }
  }
  return { errors };
}

export async function adminProductRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const guard = { preHandler: requireAdmin };
  const guardPost = { preValidation: app.csrfProtection, preHandler: requireAdmin };

  /** Replaces a product's bulk prices with the given set, in one transaction. */
  async function saveTiers(productId: string, tiers: PriceTier[]): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('product_price_tiers').where('product_id', '=', productId).execute();
      if (tiers.length > 0) {
        await trx
          .insertInto('product_price_tiers')
          .values(tiers.map((t) => ({ product_id: productId, min_qty: t.minQty, price_cents: t.priceCents })))
          .execute();
      }
    });
  }

  /** A slug nobody else has: "mug", then "mug-2", "mug-3"... */
  async function uniqueSlug(base: string, exceptId?: string): Promise<string> {
    const root = base === '' ? 'product' : base;
    const taken = new Set(
      (
        await db
          .selectFrom('products')
          .select('slug')
          .where((eb) => eb.or([eb('slug', '=', root), eb('slug', 'like', `${root}-%`)]))
          .$if(exceptId !== undefined, (q) => q.where('id', '!=', exceptId as string))
          .execute()
      ).map((r) => r.slug),
    );
    if (!taken.has(root)) return root;
    for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
  }

  async function renderForm(
    reply: FastifyReply,
    opts: { id?: string; values: FormValues; tiers?: TierRow[]; errors?: Errors; saved?: boolean; slugLive?: string | null; photo?: string | undefined },
  ) {
    const errors = opts.errors ?? {};
    const photos =
      opts.id === undefined
        ? []
        : await db
            .selectFrom('product_images')
            .select(['id', 'path', 'alt'])
            .where('product_id', '=', opts.id)
            .orderBy('sort_order')
            .orderBy('id')
            .execute();
    const photoMessage = opts.photo !== undefined && Object.hasOwn(PHOTO_MESSAGES, opts.photo) ? PHOTO_MESSAGES[opts.photo] : undefined;
    return reply
      .code(Object.keys(errors).length > 0 ? 400 : 200)
      .header('cache-control', 'no-store')
      .view('admin/product_form.njk', {
        title: opts.id === undefined ? 'Add a product' : 'Edit product',
        bodyClass: 'admin',
        csrfToken: reply.generateCsrf(),
        id: opts.id,
        values: opts.values,
        tiers: opts.tiers ?? tierRows([]),
        errors,
        hasErrors: Object.keys(errors).length > 0,
        saved: opts.saved ?? false,
        slugLive: opts.slugLive ?? null,
        photos: photos.map((p, i) => ({ id: p.id, src: `/${p.path}`, alt: p.alt, main: i === 0 })),
        photoMessage,
      });
  }

  app.get('/admin/products', guard, async (request, reply) => {
    const rows = await db
      .selectFrom('products')
      .leftJoin('product_images', 'product_images.product_id', 'products.id')
      .select((eb) => [
        'products.id', 'products.slug', 'products.name', 'products.price_cents', 'products.stock',
        'products.track_stock', 'products.active', 'products.sort_order',
        eb.fn.count<number>('product_images.id').as('images'),
      ])
      .groupBy('products.id')
      .orderBy('products.sort_order')
      .orderBy('products.name')
      .execute();
    const thumbs = await imagesFor(rows.map((r) => r.id));

    return reply.header('cache-control', 'no-store').view('admin/products.njk', {
      title: 'Products',
      bodyClass: 'admin',
      email: request.adminUser?.email,
      csrfToken: reply.generateCsrf(),
      products: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        price: formatMoney(r.price_cents),
        stock: r.track_stock ? String(r.stock) : 'not counted',
        low: r.track_stock && r.stock <= 1,
        active: r.active,
        images: Number(r.images),
        thumb: thumbs.has(r.id) ? `/${thumbs.get(r.id)!.path}` : '/placeholder/no-image.svg',
      })),
    });
  });

  app.get('/admin/products/new', guard, async (_request, reply) => renderForm(reply, { values: { ...EMPTY } }));

  app.post('/admin/products', guardPost, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const parsed = parse(body);
    const bulk = parseTiers(body, 'data' in parsed ? parsed.data.price : null);
    if ('errors' in parsed || bulk.error !== null) {
      const errors: Errors = { ...('errors' in parsed ? parsed.errors : {}), ...(bulk.error !== null ? { tiers: bulk.error } : {}) };
      return renderForm(reply, { values: echo(body), tiers: bulk.rows, errors });
    }

    const p = parsed.data;
    const slug = await uniqueSlug(p.slug !== '' ? p.slug : slugify(p.name));
    const row = await db
      .insertInto('products')
      .values({
        slug, name: p.name, description: p.description, price_cents: p.price, stock: p.stock,
        track_stock: p.track_stock, active: p.active, sort_order: p.sort_order,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await saveTiers(row.id, bulk.tiers);

    await db
      .insertInto('audit_log')
      .values({ actor: request.adminUser?.email ?? 'unknown', action: 'product.create', entity: 'product', entity_id: row.id, metadata: JSON.stringify({ slug, active: p.active }) })
      .execute();

    return reply.redirect(`/admin/products/${row.id}?saved=1`, 303);
  });

  app.get<{ Params: { id: string }; Querystring: { saved?: string; photo?: string } }>('/admin/products/:id', guard, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.callNotFound();
    const p = await db.selectFrom('products').selectAll().where('id', '=', request.params.id).executeTakeFirst();
    if (p === undefined) return reply.callNotFound();

    return renderForm(reply, {
      id: p.id,
      saved: request.query.saved === '1',
      photo: request.query.photo,
      slugLive: p.active ? p.slug : null,
      tiers: tierRows((await tiersFor([p.id], db)).get(p.id) ?? []),
      values: {
        name: p.name, slug: p.slug, description: p.description, price: priceInput(p.price_cents),
        stock: String(p.stock), sort_order: String(p.sort_order), track_stock: p.track_stock, active: p.active,
      },
    });
  });

  app.post<{ Params: { id: string } }>('/admin/products/:id', guardPost, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.callNotFound();
    const before = await db.selectFrom('products').selectAll().where('id', '=', request.params.id).executeTakeFirst();
    if (before === undefined) return reply.callNotFound();

    const body = (request.body ?? {}) as Record<string, unknown>;
    const parsed = parse(body);
    const bulk = parseTiers(body, 'data' in parsed ? parsed.data.price : null);
    if ('errors' in parsed || bulk.error !== null) {
      const errors: Errors = { ...('errors' in parsed ? parsed.errors : {}), ...(bulk.error !== null ? { tiers: bulk.error } : {}) };
      return renderForm(reply, { id: before.id, values: echo(body), tiers: bulk.rows, errors });
    }

    const p = parsed.data;
    const slug = p.slug === before.slug ? before.slug : await uniqueSlug(p.slug !== '' ? p.slug : slugify(p.name), before.id);
    const next = {
      slug, name: p.name, description: p.description, price_cents: p.price, stock: p.stock,
      track_stock: p.track_stock, active: p.active, sort_order: p.sort_order,
    };
    const changed: string[] = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== before[k]);
    const oldTiers = (await tiersFor([before.id], db)).get(before.id) ?? [];
    if (JSON.stringify(oldTiers) !== JSON.stringify(bulk.tiers)) {
      await saveTiers(before.id, bulk.tiers);
      changed.push('bulk_prices');
    }

    if (changed.length > 0) {
      if (changed.some((k) => k !== 'bulk_prices')) {
        await db.updateTable('products').set({ ...next, updated_at: new Date() }).where('id', '=', before.id).execute();
      }
      await db
        .insertInto('audit_log')
        .values({ actor: request.adminUser?.email ?? 'unknown', action: 'product.update', entity: 'product', entity_id: before.id, metadata: JSON.stringify({ changed }) })
        .execute();
    }
    return reply.redirect(`/admin/products/${before.id}?saved=1`, 303);
  });
}
