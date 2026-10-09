/**
 * Environment configuration, validated once at boot.
 *
 * A store that takes crypto payments and holds encrypted customer data should
 * never start half-configured. Every value the application depends on is
 * declared here and checked before the first request is served, so a missing
 * key or a malformed URL is a startup failure with a readable message rather
 * than a 500 at checkout three days later.
 *
 * Nothing in this file ever logs a value. Errors name the variable and what was
 * wrong with its shape, never its contents.
 */

import 'dotenv/config';
import { z } from 'zod';

import { isRecipient } from './age.js';

/** 32 raw bytes, base64 encoded. Same rule for every key in the system. */
const base64Key = z
  .string()
  .min(1)
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'must be 32 bytes, base64 encoded (generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  /** Public origin, used for BTCPay redirects and links in email. */
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().min(1).startsWith('postgres'),

  ENCRYPTION_KEY: base64Key,
  BLIND_INDEX_KEY: base64Key,
  SESSION_SECRET: base64Key,

  /** Seeds a fresh install; the live value is the `retention_days` setting. */
  DEFAULT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  // Filled in from week 2 onward. Absent is legal until then, so the app can
  // run locally before BTCPay and email exist.
  BTCPAY_URL: z.string().url().optional().or(z.literal('')),
  BTCPAY_STORE_ID: z.string().optional(),
  BTCPAY_API_KEY: z.string().optional(),
  BTCPAY_WEBHOOK_SECRET: z.string().optional(),

  /** The client's age public key. Exports and backups are locked to it. */
  EXPORT_AGE_RECIPIENT: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === '' || isRecipient(v), 'must be an age public key (age1...)'),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached !== null) return cached;

  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    // Thrown, not logged: this happens before the logger exists, and the
    // message must not be swallowed by a log level.
    throw new Error(
      `Configuration is invalid, refusing to start:\n${lines.join('\n')}\n\n` +
        `Copy .env.example to .env and fill it in.`,
    );
  }

  cached = { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' };
  return cached;
}
