/**
 * Where things are on disk, the same whether the code runs from source
 * (tsx, tests) or compiled (node dist/..., which is what production runs).
 *
 * tsc writes only .js into dist/, so templates, public files and migrations
 * stay where they are in the repo. Resolving them next to the running file
 * works from source and breaks every page once compiled.
 */

import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/src/lib or <root>/dist/src/lib
const up2 = resolve(HERE, '..', '..');

export const APP_ROOT = basename(up2) === 'dist' ? resolve(up2, '..') : up2;
export const SRC_DIR = join(APP_ROOT, 'src');
export const VIEWS_DIR = join(SRC_DIR, 'views');
export const PUBLIC_DIR = join(SRC_DIR, 'public');
export const MIGRATIONS_DIR = join(APP_ROOT, 'db', 'migrations');
