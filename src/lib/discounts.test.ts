/**
 * The pricing rules for bulk prices and discounts by order total, as pure
 * functions. The route tests check the same rules through the cart and checkout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { nextSpendTier, parseTiers, percentOff, spendPercent, spendTiers, unitPrice } from './discounts.js';

const TIERS = [{ minQty: 10, priceCents: 2000 }, { minQty: 25, priceCents: 1800 }];

test('the unit price is the normal price until a bulk quantity is reached', () => {
  assert.equal(unitPrice(2500, [], 50), 2500);
  assert.equal(unitPrice(2500, TIERS, 9), 2500);
  assert.equal(unitPrice(2500, TIERS, 10), 2000);
  assert.equal(unitPrice(2500, TIERS, 24), 2000);
  assert.equal(unitPrice(2500, TIERS, 25), 1800);
  assert.equal(unitPrice(2500, TIERS, 99), 1800);
});

test('a bulk price can never be higher than the normal price', () => {
  assert.equal(unitPrice(1500, [{ minQty: 10, priceCents: 2000 }], 10), 1500);
});

test('bulk rows: empty rows are ignored and valid rows come back sorted', () => {
  const r = parseTiers({ tier_qty_1: '25', tier_price_1: '18', tier_qty_2: '', tier_price_2: '', tier_qty_3: '10', tier_price_3: '20.00' }, 2500);
  assert.equal(r.error, null);
  assert.deepEqual(r.tiers, [{ minQty: 10, priceCents: 2000 }, { minQty: 25, priceCents: 1800 }]);
  assert.deepEqual(parseTiers({}, 2500), { rows: [{ qty: '', price: '' }, { qty: '', price: '' }, { qty: '', price: '' }], tiers: [], error: null });
});

test('bulk rows: bad input is refused with a plain message', () => {
  const bad: [Record<string, string>, RegExp][] = [
    [{ tier_qty_1: '10' }, /both the quantity and the price/],
    [{ tier_qty_1: '1', tier_price_1: '10' }, /from 2 to 99/],
    [{ tier_qty_1: '100', tier_price_1: '10' }, /from 2 to 99/],
    [{ tier_qty_1: 'ten', tier_price_1: '10' }, /from 2 to 99/],
    [{ tier_qty_1: '10', tier_price_1: 'cheap' }, /prices like/],
    [{ tier_qty_1: '10', tier_price_1: '25' }, /lower than the normal price/],
    [{ tier_qty_1: '10', tier_price_1: '20', tier_qty_2: '10', tier_price_2: '19' }, /different quantity/],
    [{ tier_qty_1: '10', tier_price_1: '18', tier_qty_2: '20', tier_price_2: '19' }, /lower price each/],
  ];
  for (const [body, message] of bad) {
    const r = parseTiers(body, 2500);
    assert.match(r.error ?? '', message, JSON.stringify(body));
    assert.deepEqual(r.tiers, []);
  }
});

const SETTINGS = { spend1_over_cents: 100_000, spend1_percent: 20, spend2_over_cents: 50_000, spend2_percent: 10, spend3_over_cents: 0, spend3_percent: 0 };

test('order-total tiers: unused rows are dropped and the rest sorted', () => {
  assert.deepEqual(spendTiers(SETTINGS), [{ overCents: 50_000, percent: 10 }, { overCents: 100_000, percent: 20 }]);
});

test('order-total tiers: the highest tier reached applies, not the sum', () => {
  const tiers = spendTiers(SETTINGS);
  assert.equal(spendPercent(tiers, 49_999), 0);
  assert.equal(spendPercent(tiers, 50_000), 10);
  assert.equal(spendPercent(tiers, 99_999), 10);
  assert.equal(spendPercent(tiers, 100_000), 20);
  assert.equal(spendPercent([], 1_000_000), 0);
});

test('order-total tiers: the next tier is offered as a hint', () => {
  const tiers = spendTiers(SETTINGS);
  assert.deepEqual(nextSpendTier(tiers, 30_000), { overCents: 50_000, percent: 10 });
  assert.deepEqual(nextSpendTier(tiers, 60_000), { overCents: 100_000, percent: 20 });
  assert.equal(nextSpendTier(tiers, 100_000), null);
});

test('percent off rounds down to whole cents', () => {
  assert.equal(percentOff(9999, 10), 999);
  assert.equal(percentOff(50_000, 10), 5000);
});
