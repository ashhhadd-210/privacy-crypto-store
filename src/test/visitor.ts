/**
 * A browser, minus the browser, for tests: remembers cookies between requests
 * through `app.inject()`, and fetches a CSRF token from a real page.
 */

import assert from 'node:assert/strict';

import type { buildServer } from '../server.js';

type App = Awaited<ReturnType<typeof buildServer>>;
export type Res = Awaited<ReturnType<App['inject']>>;

export class Visitor {
  jar = new Map<string, string>();
  // Its own address, so one test's attempts never count against another's rate limit.
  ip = `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 254) + 1).join('.')}`;

  constructor(
    private readonly app: App,
    /** Any page that renders a form carrying `_csrf`. */
    private readonly tokenPage: string,
  ) {}

  private remember(res: Res): Res {
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (c.value === '' || (c.expires !== undefined && c.expires.getTime() < Date.now())) {
        this.jar.delete(c.name);
      } else {
        this.jar.set(c.name, c.value);
      }
    }
    return res;
  }

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  async get(url: string): Promise<Res> {
    return this.remember(
      await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookieHeader(), 'x-forwarded-for': this.ip } }),
    );
  }

  async post(url: string, fields: Record<string, string>, withToken = true): Promise<Res> {
    const body = new URLSearchParams(fields);
    if (withToken && !body.has('_csrf')) body.set('_csrf', await this.token());
    return this.remember(
      await this.app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: this.cookieHeader(),
          'x-forwarded-for': this.ip,
        },
        payload: body.toString(),
      }),
    );
  }

  async token(): Promise<string> {
    const page = await this.get(this.tokenPage);
    const match = /name="_csrf" value="([^"]+)"/.exec(page.body);
    assert.ok(match?.[1], `${this.tokenPage} must carry a CSRF token`);
    return match[1];
  }

  applyCode(code: string): Promise<Res> {
    return this.post('/cart/promo', { code });
  }

  add(slug: string, qty?: number): Promise<Res> {
    return this.post('/cart/add', qty === undefined ? { slug } : { slug, qty: String(qty) });
  }
}
