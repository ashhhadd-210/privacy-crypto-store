/**
 * Admin product photos: upload, remove, make main.
 *
 * Multipart parsing is registered in this scope only, so no other route in the
 * store accepts file uploads. The whole request is capped (one file, a few
 * fields, 10 MB); `keyValues` puts the CSRF token in `request.body`, where the
 * CSRF check reads it, so the token never has to go in the URL.
 */

import multipart from '@fastify/multipart';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

import { getDb } from '../lib/db.js';
import { ImageRejected, MAX_UPLOAD_BYTES, deleteStoredImage, processProductImage, storeProductImage } from '../lib/images.js';
import { requireAdmin } from './admin.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fixed messages chosen by code on the edit page; nothing from the request is echoed. */
export const PHOTO_MESSAGES: Record<string, { text: string; error?: true }> = {
  added: { text: 'Photo added. Its location and camera details were removed.' },
  removed: { text: 'Photo removed.' },
  main: { text: 'Main photo changed.' },
  'too-big': { text: 'That photo is larger than 10 MB. Try a smaller copy.', error: true },
  empty: { text: 'Choose a photo to upload.', error: true },
  type: { text: 'Use a JPEG, PNG or WebP photo.', error: true },
  heic: { text: 'iPhone HEIC photos are not supported yet. Export it as JPEG (or set Camera, Formats to "Most Compatible") and try again.', error: true },
  unreadable: { text: 'That photo could not be read. It may be damaged, or too large in pixels.', error: true },
};

const back = (reply: FastifyReply, id: string, code: string) =>
  reply.redirect(`/admin/products/${id}?photo=${code}#photos`, 303);

export async function adminImageRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  async function audit(actor: string | undefined, action: string, productId: string, metadata: object) {
    await db
      .insertInto('audit_log')
      .values({ actor: actor ?? 'unknown', action, entity: 'product', entity_id: productId, metadata: JSON.stringify(metadata) })
      .execute();
  }

  async function productExists(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return (await db.selectFrom('products').select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
  }

  // --- upload: the only multipart route in the store -------------------------
  await app.register(async (scope) => {
    await scope.register(multipart, {
      attachFieldsToBody: 'keyValues',
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3, parts: 4, fieldSize: 1024 },
    });

    scope.setErrorHandler((error: FastifyError, request, reply) => {
      const id = (request.params as { id?: string }).id ?? '';
      if (error.code === 'FST_REQ_FILE_TOO_LARGE' && UUID.test(id)) return back(reply, id, 'too-big');
      throw error; // everything else goes to the store-wide handler
    });

    scope.post<{ Params: { id: string } }>(
      '/admin/products/:id/images',
      { preValidation: app.csrfProtection, preHandler: requireAdmin },
      async (request, reply) => {
        const { id } = request.params;
        if (!(await productExists(id))) return reply.callNotFound();

        const body = (request.body ?? {}) as Record<string, unknown>;
        const file = body['image'];
        const alt = typeof body['alt'] === 'string' ? body['alt'].trim().slice(0, 200) : '';
        if (!Buffer.isBuffer(file)) return back(reply, id, 'empty');

        let path: string;
        try {
          path = await storeProductImage(await processProductImage(file));
        } catch (err) {
          if (err instanceof ImageRejected) return back(reply, id, err.code);
          throw err;
        }

        const last = await db
          .selectFrom('product_images')
          .select((eb) => eb.fn.max<number>('sort_order').as('max'))
          .where('product_id', '=', id)
          .executeTakeFirst();
        const product = await db.selectFrom('products').select('name').where('id', '=', id).executeTakeFirstOrThrow();
        await db
          .insertInto('product_images')
          .values({ product_id: id, path, alt: alt !== '' ? alt : product.name, sort_order: (last?.max ?? 0) + 1 })
          .execute();
        await audit(request.adminUser?.email, 'product.image.add', id, { path });
        return back(reply, id, 'added');
      },
    );
  });

  // --- remove and reorder: ordinary small forms ------------------------------
  const guardPost = { preValidation: app.csrfProtection, preHandler: requireAdmin };

  app.post<{ Params: { id: string; imageId: string } }>(
    '/admin/products/:id/images/:imageId/delete',
    guardPost,
    async (request, reply) => {
      const { id, imageId } = request.params;
      if (!UUID.test(id) || !UUID.test(imageId)) return reply.callNotFound();
      const image = await db
        .deleteFrom('product_images')
        .where('id', '=', imageId)
        .where('product_id', '=', id)
        .returning('path')
        .executeTakeFirst();
      if (image === undefined) return reply.callNotFound();
      await deleteStoredImage(image.path);
      await audit(request.adminUser?.email, 'product.image.remove', id, { path: image.path });
      return back(reply, id, 'removed');
    },
  );

  app.post<{ Params: { id: string; imageId: string } }>(
    '/admin/products/:id/images/:imageId/main',
    guardPost,
    async (request, reply) => {
      const { id, imageId } = request.params;
      if (!UUID.test(id) || !UUID.test(imageId)) return reply.callNotFound();
      const first = await db
        .selectFrom('product_images')
        .select((eb) => eb.fn.min<number>('sort_order').as('min'))
        .where('product_id', '=', id)
        .executeTakeFirst();
      const updated = await db
        .updateTable('product_images')
        .set({ sort_order: (first?.min ?? 1) - 1 })
        .where('id', '=', imageId)
        .where('product_id', '=', id)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) return reply.callNotFound();
      await audit(request.adminUser?.email, 'product.image.main', id, { imageId });
      return back(reply, id, 'main');
    },
  );
}
