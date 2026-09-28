/**
 * Migration runner.
 *
 * Applies every `db/migrations/NNN_*.sql` file that has not been applied yet,
 * in filename order. Deliberately small: the migrations themselves are plain
 * SQL so that whoever inherits this project after handover can read the schema
 * without learning a migration framework.
 *
 *   npm run migrate            apply pending migrations
 *   npm run migrate -- --dry   list what would run, change nothing
 *
 * Safety properties that matter on a live store:
 *
 * - A Postgres advisory lock means two deploys racing each other cannot apply
 *   the same migration twice. The second one waits, then finds nothing to do.
 * - Each applied file's SHA-256 is recorded. Editing a migration that has
 *   already run is refused, because the server's schema and the repo would
 *   silently disagree from then on.
 * - A file that carries its own BEGIN/COMMIT (001_init.sql does) has that outer
 *   pair stripped before execution, so the schema change and the row recording
 *   it commit together. A migration can never be half-recorded.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import 'dotenv/config';
import { Client } from 'pg';

import { MIGRATIONS_DIR } from '../src/lib/paths.js';


/** Arbitrary but fixed: identifies this project's migration lock. */
const LOCK_KEY = 0x6461766d; // 'davm'

const dryRun = process.argv.includes('--dry');

function fail(message: string): never {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR).catch(() =>
    fail(`cannot read ${MIGRATIONS_DIR}`),
  );
  const sql = entries.filter((f) => f.endsWith('.sql')).sort();
  if (sql.length === 0) fail(`no .sql files in ${MIGRATIONS_DIR}`);
  return sql;
}

/**
 * Strips an outer `BEGIN; ... COMMIT;` pair so the runner can own the
 * transaction instead. Only a leading BEGIN and a trailing COMMIT are touched,
 * both anchored to the ends of the file, so a COMMIT inside a dollar-quoted
 * function body is never mistaken for the closing one. Anything that does not
 * match this exact shape is returned untouched and runs as written.
 */
function unwrapOuterTransaction(sql: string): string {
  const leadingBegin = /^((?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*)BEGIN\s*;/i;
  const trailingCommit = /COMMIT\s*;\s*$/i;

  if (!leadingBegin.test(sql) || !trailingCommit.test(sql)) return sql;
  return sql.replace(leadingBegin, '$1').replace(trailingCommit, '');
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) fail('DATABASE_URL is not set (copy .env.example to .env)');

  const files = await migrationFiles();
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (err) {
    fail(`cannot connect to the database: ${(err as Error).message}`);
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT        NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    let ran = 0;

    for (const filename of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(filename);

      if (previous !== undefined) {
        if (previous !== checksum) {
          fail(
            `${filename} has changed since it was applied.\n` +
              '  Migrations are immutable once they run. Add a new numbered file instead.',
          );
        }
        continue;
      }

      if (dryRun) {
        console.log(`would apply ${filename}`);
        ran++;
        continue;
      }

      const body = unwrapOuterTransaction(sql);
      const started = Date.now();

      try {
        await client.query('BEGIN');
        await client.query(body);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        fail(`${filename} failed: ${(err as Error).message}`);
      }

      console.log(`applied ${filename} (${Date.now() - started}ms)`);
      ran++;
    }

    if (dryRun && ran > 0) console.log(`${ran} migration(s) pending`);
    else if (ran === 0) console.log(`up to date, ${applied.size} migration(s) already applied`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

await main();
