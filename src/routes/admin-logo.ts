/**
 * The store's logo, uploaded by the owner from Settings (client request,
 * 16 Oct). Shown in the shop header and footer and the admin header; without
 * one, the placeholder logo is used.
 *
 * Same safety as product photos: JPEG, PNG or WebP only (never SVG, which can
 * carry script), re-encoded from scratch so no metadata survives, stored under
 * a random name. Multipart is registered in this scope only.
 */

import multipart from '@fastify/multipart';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

import { getDb } from '../lib/db.js';
import { ImageRejected, MAX_UPLOAD_BYTES, deleteStoredImage, processLogoImage, storeProductImage } from '../lib/images.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { requireAdmin } from './admin.js';

/** Fixed messages chosen by code; nothing from the request is echoed. */
export const LOGO_MESSAGES: Record<string, { text: string; error?: true }> = {
  added: { text: 'Logo updated. It now shows at the top and bottom of every page.' },
  removed: { text: 'Logo removed. The placeholder logo is shown until you upload a new one.' },
  'too-big': { text: 'That file is larger than 10 MB. Try a smaller copy.', error: true },
  empty: { text: 'Choose a logo file to upload.', error: true },
  type: { text: 'Use a PNG, JPEG or WebP image. A PNG with a transparent background works best.', error: true },
  heic: { text: 'iPhone HEIC images are not supported. Export it as PNG or JPEG and try again.', error: true },
  unreadable: { text: 'That image could not be read. It may be damaged, or too large in pixels.', error: true },
};

const back = (reply: FastifyReply, code: string) => reply.redirect(`/admin/settings?logo=${code}#logo`, 303);

export async function adminLogoRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  async function setLogo(actor: string | undefined, path: string): Promise<void> {
    const before = (await getSettings(db)).logo_path;
    await saveSettings(db, { logo_path: path });
    if (before !== '' && before !== path) await deleteStoredImage(before);
    await db
      .insertInto('audit_log')
      .values({ actor: actor ?? 'unknown', action: path === '' ? 'settings.logo.remove' : 'settings.logo.set', entity: 'settings', entity_id: null, metadata: JSON.stringify({ path }) })
      .execute();
  }

  await app.register(async (scope) => {
    await scope.register(multipart, {
      attachFieldsToBody: 'keyValues',
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 1024 },
    });
    scope.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') return back(reply, 'too-big');
      throw error;
    });
    scope.post('/admin/settings/logo', { preValidation: app.csrfProtection, preHandler: requireAdmin }, async (request, reply) => {
      const file = ((request.body ?? {}) as Record<string, unknown>)['logo'];
      if (!Buffer.isBuffer(file)) return back(reply, 'empty');
      let path: string;
      try {
        path = await storeProductImage(await processLogoImage(file));
      } catch (err) {
        if (err instanceof ImageRejected) return back(reply, err.code);
        throw err;
      }
      await setLogo(request.adminUser?.email, path);
      return back(reply, 'added');
    });
  });

  app.post('/admin/settings/logo/remove', { preValidation: app.csrfProtection, preHandler: requireAdmin }, async (request, reply) => {
    await setLogo(request.adminUser?.email, '');
    return back(reply, 'removed');
  });
}
