/**
 * The cart lives entirely in one signed cookie: product ids and quantities,
 * nothing else. There is no cart table, so the server holds no record of who
 * browsed what, and an abandoned cart leaves nothing behind to purge. It is a
 * session cookie: it goes when the browser closes.
 *
 * The signature stops a visitor editing quantities by hand, but the cookie is
 * never trusted for anything that matters. Prices, stock and whether a product
 * is still on sale are read from the database on every request.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { loadConfig } from './config.js';

export const CART_COOKIE = 'cart';
export const PROMO_COOKIE = 'promo';
export const MAX_LINES = 20;
export const MAX_QTY = 10;

export type Cart = Map<string, number>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseCart(raw: string): Cart {
  const cart: Cart = new Map();
  for (const entry of raw.split(',')) {
    const [id, qtyText] = entry.split(':');
    const qty = Number(qtyText);
    if (id === undefined || !UUID.test(id) || !Number.isInteger(qty) || qty < 1) continue;
    if (cart.size >= MAX_LINES) break;
    cart.set(id, Math.min(qty, MAX_QTY));
  }
  return cart;
}

export function serializeCart(cart: Cart): string {
  return [...cart].map(([id, qty]) => `${id}:${qty}`).join(',');
}

/** A missing, malformed or tampered cookie is an empty cart, never an error. */
export function readCart(request: FastifyRequest): Cart {
  const raw = request.cookies[CART_COOKIE];
  if (raw === undefined) return new Map();
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value !== null ? parseCart(unsigned.value) : new Map();
}

function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    // Lax, not strict: a visitor arriving from a link should still see their cart.
    sameSite: 'lax' as const,
    secure: loadConfig().isProduction,
    signed: true,
  };
}

export function writeCart(reply: FastifyReply, cart: Cart): FastifyReply {
  if (cart.size === 0) return reply.clearCookie(CART_COOKIE, cookieOptions());
  return reply.setCookie(CART_COOKIE, serializeCart(cart), cookieOptions());
}

/** The code as typed, normalised. Whether it is usable is decided on every render. */
export function readPromoCode(request: FastifyRequest): string | null {
  const raw = request.cookies[PROMO_COOKIE];
  if (raw === undefined) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function writePromoCode(reply: FastifyReply, code: string | null): FastifyReply {
  if (code === null) return reply.clearCookie(PROMO_COOKIE, cookieOptions());
  return reply.setCookie(PROMO_COOKIE, code, cookieOptions());
}

export function itemCount(cart: Cart): number {
  let n = 0;
  for (const qty of cart.values()) n += qty;
  return n;
}
