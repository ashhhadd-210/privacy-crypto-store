/**
 * Rules for the admin product form: what a price, a slug and each field may
 * be. Kept apart from the routes so they can be tested directly.
 */

import { z } from 'zod';

export const MAX_PRICE_CENTS = 99_999_999; // $999,999.99

/**
 * "24" is 2400 cents; "24.5" and "24.50" are 2450. Parsed as text, never
 * through a float, so "0.29" is 29 cents and not 28.999999. A leading "$" and
 * thousands commas are tolerated because people type them.
 */
export function parsePrice(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (m === null) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents <= MAX_PRICE_CENTS ? cents : null;
}

/** Cents back to the text the form shows: 2450 -> "24.50". */
export function priceInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** "Sample Product Two — Extended!" -> "sample-product-two-extended". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const checkbox = z.preprocess((v) => v === 'on' || v === 'true' || v === '1', z.boolean());

export const productForm = z.object({
  name: z.string().trim().min(1, 'Give the product a name.').max(200, 'That name is too long (200 characters at most).'),
  slug: z
    .string()
    .default('')
    .pipe(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(80, 'That web address is too long.')
        .refine((s) => s === '' || SLUG.test(s), 'Use lower-case letters, numbers and single dashes only.'),
    ),
  description: z.string().max(10_000, 'That description is too long (10,000 characters at most).').default(''),
  price: z.string().transform((v, ctx) => {
    const cents = parsePrice(v);
    if (cents === null) {
      ctx.addIssue({ code: 'custom', message: 'Enter a price like 24 or 24.50.' });
      return z.NEVER;
    }
    return cents;
  }),
  stock: z.coerce
    .number({ invalid_type_error: 'Enter a whole number.' })
    .int('Enter a whole number.')
    .min(0, 'Stock cannot be negative.')
    .max(1_000_000, 'That is more stock than the shop can count.'),
  track_stock: checkbox,
  active: checkbox,
  sort_order: z.coerce.number().int('Enter a whole number.').min(0).max(100_000).default(0),
});

export type ProductForm = z.infer<typeof productForm>;
export const FORM_FIELDS = ['name', 'slug', 'description', 'price', 'stock', 'sort_order'] as const;
