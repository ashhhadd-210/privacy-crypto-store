/**
 * Light or dark, chosen by the visitor. Dark is the brand and the default.
 *
 * No JavaScript: the toggle in the header is a plain link here, which sets a
 * one-word preference cookie and sends the visitor back to the page they were
 * on. The cookie holds "light" or "dark" and nothing else, so it identifies
 * no one; it is a setting, not tracking.
 */

import type { FastifyInstance } from 'fastify';

import { loadConfig } from '../lib/config.js';

export const THEME_COOKIE = 'theme';
export type Theme = 'light' | 'dark';

export function themeFrom(value: unknown): Theme {
  return value === 'light' ? 'light' : 'dark';
}

/**
 * Only a path on this site. "//evil.example" and "/\evil.example" are both
 * treated by browsers as another host, so they are refused like full URLs.
 */
export function safeBack(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\r\n]/.test(value)) return '/';
  return value;
}

export async function themeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { mode: string }; Querystring: { back?: string } }>('/theme/:mode', async (request, reply) => {
    const { mode } = request.params;
    if (mode !== 'light' && mode !== 'dark') return reply.code(404).send();
    return reply
      .setCookie(THEME_COOKIE, mode, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: loadConfig().isProduction,
        maxAge: 60 * 60 * 24 * 365,
      })
      .header('cache-control', 'no-store')
      .redirect(safeBack(request.query.back), 303);
  });
}
