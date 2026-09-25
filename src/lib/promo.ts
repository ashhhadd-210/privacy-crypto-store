/**
 * Discount codes.
 *
 * A code is re-checked on every cart render, not just when it is typed in:
 * it can expire, run out or be switched off while it sits in a cart. Usage is
 * not counted here. `used_count` goes up when an order is paid, so an abandoned
 * cart never burns a use.
 *
 * Every reason a code cannot be used today (unknown, expired, not started, used
 * up, switched off) produces the same answer, so the form cannot be used to
 * discover which codes exist.
 */

import { type Kysely, type Transaction, sql } from 'kysely';

import { type Database, getDb } from './db.js';

export const MAX_CODE_LENGTH = 40;

export interface Promotion {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  minSubtotalCents: number;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

export async function findUsablePromotion(
  code: string,
  now = new Date(),
  db: Kysely<Database> | Transaction<Database> = getDb(),
): Promise<Promotion | null> {
  const normalized = normalizeCode(code);
  if (normalized === '' || normalized.length > MAX_CODE_LENGTH) return null;

  const row = await db
    .selectFrom('promotions')
    .select(['id', 'code', 'type', 'value', 'min_subtotal_cents'])
    .where(sql<string>`upper(code)`, '=', normalized)
    .where('active', '=', true)
    .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '<=', now)]))
    .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
    .where((eb) => eb.or([eb('max_uses', 'is', null), eb('used_count', '<', eb.ref('max_uses'))]))
    .executeTakeFirst();

  if (row === undefined) return null;
  return { id: row.id, code: row.code, type: row.type, value: row.value, minSubtotalCents: row.min_subtotal_cents };
}

/**
 * Whole cents, rounded down: a customer never gets more off than the code
 * says. Never more than the subtotal, so a total cannot go below zero.
 */
export function discountCents(promo: Promotion, subtotalCents: number): number {
  if (subtotalCents < promo.minSubtotalCents) return 0;
  const raw = promo.type === 'percent' ? Math.floor((subtotalCents * promo.value) / 100) : promo.value;
  return Math.min(raw, subtotalCents);
}

export function describe(promo: Promotion, format: (cents: number) => string): string {
  return promo.type === 'percent' ? `${promo.value}% off` : `${format(promo.value)} off`;
}
