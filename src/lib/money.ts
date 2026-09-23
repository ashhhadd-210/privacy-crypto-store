/**
 * Money formatting.
 *
 * Every amount in this system is an integer number of cents, all the way from
 * the database to the invoice. No floating point touches a price at any point:
 * 0.1 + 0.2 is a funny example in a blog post and a support ticket in a shop.
 *
 * Formatting happens here, once, so a price rendered on the catalogue, the
 * product page, the cart and the confirmation email is formatted by the same
 * code and cannot drift.
 */

const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let f = FORMATTERS.get(currency);
  if (f === undefined) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    });
    FORMATTERS.set(currency, f);
  }
  return f;
}

/** 2400 -> "$24.00" */
export function formatMoney(cents: number, currency = 'USD'): string {
  return formatter(currency).format(cents / 100);
}
