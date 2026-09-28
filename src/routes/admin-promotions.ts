/**
 * Admin discount codes: list, add, edit, switch on and off.
 *
 * No delete: orders keep a link to the code they used, and a switched-off code
 * does exactly what a deleted one would at checkout. Codes are stored upper
 * case and matched case-insensitively, so "summer10" and "SUMMER10" can never
 * both exist. Dates are whole days in UTC: a code runs from the start of its
 * first day to the end of its last.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import { getDb } from '../lib/db.js';
import { formatMoney } from '../lib/money.js';
import { parsePrice, priceInput } from '../lib/product-form.js';
import { requireAdmin } from './admin.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ['code', 'type', 'value', 'min_spend', 'max_uses', 'starts', 'ends'] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string> & { active: boolean };
type Errors = Partial<Record<Field, string>>;

const EMPTY: Values = { code: '', type: 'percent', value: '', min_spend: '', max_uses: '', starts: '', ends: '', active: true };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(s: string): Date | null {
  if (!DAY.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

interface Parsed {
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  min_subtotal_cents: number;
  max_uses: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  active: boolean;
}

function parse(body: Record<string, unknown>): { values: Values; errors: Errors; data?: Parsed } {
  const v: Values = { ...EMPTY };
  for (const f of FIELDS) if (typeof body[f] === 'string') v[f] = (body[f] as string).trim().slice(0, 100);
  v.code = v.code.toUpperCase();
  v.active = body['active'] === 'on';
  const e: Errors = {};

  if (!/^[A-Z0-9-]{3,40}$/.test(v.code)) e.code = 'Use 3 to 40 letters, numbers or dashes, like SUMMER10.';
  const type = v.type === 'fixed' ? 'fixed' : 'percent';

  let value = 0;
  if (type === 'percent') {
    value = Number(v.value.replace(/%$/, ''));
    if (!Number.isInteger(value) || value < 1 || value > 100) e.value = 'Enter a whole percentage from 1 to 100.';
  } else {
    const cents = parsePrice(v.value);
    if (cents === null || cents < 1) e.value = 'Enter an amount like 5 or 5.50.';
    else value = cents;
  }

  let min = 0;
  if (v.min_spend !== '') {
    const cents = parsePrice(v.min_spend);
    if (cents === null) e.min_spend = 'Enter an amount like 50, or leave it empty.';
    else min = cents;
  }

  let maxUses: number | null = null;
  if (v.max_uses !== '') {
    maxUses = Number(v.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) e.max_uses = 'Enter a whole number, or leave it empty for no limit.';
  }

  const starts = v.starts === '' ? null : validDay(v.starts);
  if (v.starts !== '' && starts === null) e.starts = 'Pick a date, or leave it empty to start now.';
  const endDay = v.ends === '' ? null : validDay(v.ends);
  if (v.ends !== '' && endDay === null) e.ends = 'Pick a date, or leave it empty for no end.';
  const ends = endDay === null ? null : new Date(endDay.getTime() + 86_400_000); // end of that day
  if (starts !== null && ends !== null && ends <= starts) e.ends = 'The last day must be on or after the first.';

  if (Object.keys(e).length > 0) return { values: v, errors: e };
  return {
    values: v,
    errors: e,
    data: { code: v.code, type, value, min_subtotal_cents: min, max_uses: maxUses, starts_at: starts, ends_at: ends, active: v.active },
  };
}

const day = (d: Date | null) => (d === null ? '' : d.toISOString().slice(0, 10));
const lastDay = (d: Date | null) => (d === null ? '' : new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10));

export async function adminPromotionRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const guard = { preHandler: requireAdmin };
  const guardPost = { preValidation: app.csrfProtection, preHandler: requireAdmin };

  async function audit(actor: string | undefined, action: string, id: string, metadata: object) {
    await db
      .insertInto('audit_log')
      .values({ actor: actor ?? 'unknown', action, entity: 'promotion', entity_id: id, metadata: JSON.stringify(metadata) })
      .execute();
  }

  async function codeTaken(code: string, exceptId?: string): Promise<boolean> {
    const row = await db
      .selectFrom('promotions')
      .select('id')
      .where(sql<string>`upper(code)`, '=', code)
      .$if(exceptId !== undefined, (q) => q.where('id', '!=', exceptId as string))
      .executeTakeFirst();
    return row !== undefined;
  }

  function form(reply: FastifyReply, opts: { id?: string; values: Values; errors?: Errors; saved?: boolean; uses?: number }) {
    const errors = opts.errors ?? {};
    return reply
      .code(Object.keys(errors).length > 0 ? 400 : 200)
      .header('cache-control', 'no-store')
      .view('admin/promotion_form.njk', {
        title: opts.id === undefined ? 'Add a discount code' : 'Edit discount code',
        bodyClass: 'admin',
        section: 'promotions',
        csrfToken: reply.generateCsrf(),
        id: opts.id,
        values: opts.values,
        errors,
        hasErrors: Object.keys(errors).length > 0,
        saved: opts.saved ?? false,
        uses: opts.uses ?? 0,
      });
  }

  app.get('/admin/promotions', guard, async (_request, reply) => {
    const now = Date.now();
    const rows = await db.selectFrom('promotions').selectAll().orderBy('active', 'desc').orderBy('code').execute();
    return reply.header('cache-control', 'no-store').view('admin/promotions.njk', {
      title: 'Discount codes',
      bodyClass: 'admin',
      section: 'promotions',
      csrfToken: reply.generateCsrf(),
      promotions: rows.map((p) => {
        const state = !p.active
          ? 'Off'
          : p.starts_at !== null && p.starts_at.getTime() > now
            ? 'Scheduled'
            : p.ends_at !== null && p.ends_at.getTime() <= now
              ? 'Ended'
              : p.max_uses !== null && p.used_count >= p.max_uses
                ? 'Used up'
                : 'Live';
        return {
          id: p.id,
          code: p.code,
          amount: p.type === 'percent' ? `${p.value}% off` : `${formatMoney(p.value)} off`,
          minimum: p.min_subtotal_cents > 0 ? formatMoney(p.min_subtotal_cents) : null,
          uses: p.max_uses === null ? `${p.used_count}` : `${p.used_count} of ${p.max_uses}`,
          window: p.starts_at === null && p.ends_at === null ? 'Always' : `${day(p.starts_at) || 'now'} to ${lastDay(p.ends_at) || 'no end'}`,
          state,
        };
      }),
    });
  });

  app.get('/admin/promotions/new', guard, async (_request, reply) => form(reply, { values: { ...EMPTY } }));

  app.post('/admin/promotions', guardPost, async (request, reply) => {
    const { values, errors, data } = parse((request.body ?? {}) as Record<string, unknown>);
    if (data === undefined) return form(reply, { values, errors });
    if (await codeTaken(data.code)) return form(reply, { values, errors: { code: 'That code already exists.' } });
    const row = await db.insertInto('promotions').values(data).returning('id').executeTakeFirstOrThrow();
    await audit(request.adminUser?.email, 'promotion.create', row.id, { code: data.code });
    return reply.redirect(`/admin/promotions/${row.id}?saved=1`, 303);
  });

  app.get<{ Params: { id: string }; Querystring: { saved?: string } }>('/admin/promotions/:id', guard, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.callNotFound();
    const p = await db.selectFrom('promotions').selectAll().where('id', '=', request.params.id).executeTakeFirst();
    if (p === undefined) return reply.callNotFound();
    return form(reply, {
      id: p.id,
      saved: request.query.saved === '1',
      uses: p.used_count,
      values: {
        code: p.code,
        type: p.type,
        value: p.type === 'percent' ? String(p.value) : priceInput(p.value),
        min_spend: p.min_subtotal_cents > 0 ? priceInput(p.min_subtotal_cents) : '',
        max_uses: p.max_uses === null ? '' : String(p.max_uses),
        starts: day(p.starts_at),
        ends: lastDay(p.ends_at),
        active: p.active,
      },
    });
  });

  app.post<{ Params: { id: string } }>('/admin/promotions/:id', guardPost, async (request, reply) => {
    const { id } = request.params;
    if (!UUID.test(id)) return reply.callNotFound();
    const before = await db.selectFrom('promotions').selectAll().where('id', '=', id).executeTakeFirst();
    if (before === undefined) return reply.callNotFound();

    const { values, errors, data } = parse((request.body ?? {}) as Record<string, unknown>);
    const uses = before.used_count;
    if (data === undefined) return form(reply, { id, values, errors, uses });
    if (await codeTaken(data.code, id)) return form(reply, { id, values, errors: { code: 'That code already exists.' }, uses });

    await db.updateTable('promotions').set(data).where('id', '=', id).execute();
    const changed = (Object.keys(data) as (keyof Parsed)[]).filter((k) => {
      const a = data[k];
      const b = before[k];
      return a instanceof Date || b instanceof Date ? String(a?.valueOf()) !== String((b as Date | null)?.valueOf()) : a !== b;
    });
    if (changed.length > 0) await audit(request.adminUser?.email, 'promotion.update', id, { changed });
    return reply.redirect(`/admin/promotions/${id}?saved=1`, 303);
  });
}
