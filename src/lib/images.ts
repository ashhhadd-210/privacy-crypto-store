/**
 * Product photo processing.
 *
 * The uploaded file is never stored. It is decoded, turned the right way up
 * (phones record rotation as metadata), resized, and written out as a new
 * WebP. Re-encoding carries none of the original's metadata across: no camera
 * serial, no GPS position, no owner name. For a store whose owner photographs
 * products at home, the GPS tag alone would publish their address.
 *
 * Only JPEG, PNG and WebP are accepted. SVG in particular is refused: it can
 * carry script, and it would be served from the shop's own origin.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { PUBLIC_DIR } from './paths.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 40 megapixels: any real product photo, and no decompression bomb. */
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 1200;
const ACCEPTED = new Set(['jpeg', 'png', 'webp']);

export const UPLOAD_DIR = join(PUBLIC_DIR, 'uploads');

export type RejectCode = 'empty' | 'too-big' | 'type' | 'heic' | 'unreadable';

export class ImageRejected extends Error {
  constructor(readonly code: RejectCode) {
    super(`image rejected: ${code}`);
  }
}

export async function processProductImage(input: Buffer): Promise<Buffer> {
  if (input.length === 0) throw new ImageRejected('empty');
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageRejected('too-big');

  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw new ImageRejected('type');
  }
  if (format === 'heif') throw new ImageRejected('heic');
  if (format === undefined || !ACCEPTED.has(format)) throw new ImageRejected('type');

  try {
    return await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new ImageRejected('unreadable');
  }
}

/** Writes a processed photo under a random name; returns its path relative to public/. */
export async function storeProductImage(processed: Buffer): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${randomBytes(16).toString('hex')}.webp`;
  await writeFile(join(UPLOAD_DIR, name), processed, { flag: 'wx' });
  return `uploads/${name}`;
}

/** Deletes an uploaded photo's file. Placeholders and anything outside uploads/ are left alone. */
export async function deleteStoredImage(path: string): Promise<void> {
  const m = /^uploads\/([0-9a-f]{32}\.webp)$/.exec(path);
  if (m === null) return;
  await unlink(join(UPLOAD_DIR, m[1] as string)).catch(() => undefined);
}
