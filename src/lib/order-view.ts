/**
 * How an order is shown, the same everywhere: the confirmation page, order
 * lookup, the customer's account, the admin and the order emails. Each line
 * says when a bulk price applied and what the normal price was; each discount
 * says what it was. A correct order should also look correct.
 */

import { formatMoney } from './money.js';

export const ORDER_SUMMARY_COLUMNS = [
  'subtotal_cents',
  'discount_cents',
  'order_discount_cents',
  'order_discount_percent',
  'code_discount_cents',
  'shipping_cents',
  'total_cents',
] as const;

export const ORDER_ITEM_COLUMNS = ['name_snapshot', 'quantity', 'unit_price_cents', 'base_price_cents', 'line_total_cents'] as const;

export interface OrderTotalsRow {
  subtotal_cents: number;
  discount_cents: number;
  order_discount_cents: number;
  order_discount_percent: number;
  code_discount_cents: number;
  shipping_cents: number;
  total_cents: number;
}

export interface OrderItemRow {
  name_snapshot: string;
  quantity: number;
  unit_price_cents: number;
  base_price_cents: number | null;
  line_total_cents: number;
}

export interface ItemView {
  name: string;
  qty: number;
  unit: string;
  /** The normal price, when a bulk price applied. */
  normally: string | null;
  total: string;
}

export interface TotalsView {
  subtotal: string;
  discounts: { label: string; amount: string }[];
  shipping: string;
  total: string;
}

export function itemView(i: OrderItemRow): ItemView {
  return {
    name: i.name_snapshot,
    qty: i.quantity,
    unit: formatMoney(i.unit_price_cents),
    normally: i.base_price_cents !== null && i.base_price_cents > i.unit_price_cents ? formatMoney(i.base_price_cents) : null,
    total: formatMoney(i.line_total_cents),
  };
}

export function totalsView(o: OrderTotalsRow): TotalsView {
  const discounts: { label: string; amount: string }[] = [];
  if (o.order_discount_cents > 0) {
    discounts.push({ label: `Order discount (${o.order_discount_percent}%)`, amount: formatMoney(o.order_discount_cents) });
  }
  if (o.code_discount_cents > 0) discounts.push({ label: 'Discount code', amount: formatMoney(o.code_discount_cents) });
  // Orders from before the breakdown was recorded: one line, as they always showed.
  if (discounts.length === 0 && o.discount_cents > 0) discounts.push({ label: 'Discount', amount: formatMoney(o.discount_cents) });
  return {
    subtotal: formatMoney(o.subtotal_cents),
    discounts,
    shipping: o.shipping_cents === 0 ? 'Free' : formatMoney(o.shipping_cents),
    total: formatMoney(o.total_cents),
  };
}

/** Plain-text version for emails. */
export function textLines(items: OrderItemRow[]): string {
  return items
    .map((i) => {
      const v = itemView(i);
      const each = v.normally ? ` (${v.unit} each, bulk price; normally ${v.normally})` : '';
      return `  ${v.qty} x ${v.name}${each}  ${v.total}`;
    })
    .join('\n');
}

export function textTotals(o: OrderTotalsRow): string {
  const t = totalsView(o);
  return [
    `  Subtotal  ${t.subtotal}`,
    ...t.discounts.map((d) => `  ${d.label}  -${d.amount}`),
    `  Shipping  ${t.shipping}`,
    `  Total     ${t.total}`,
  ].join('\n');
}
