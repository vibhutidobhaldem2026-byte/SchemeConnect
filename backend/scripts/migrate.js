/**
 * Migration runner.
 *
 * Plain .sql files in migrations/, applied in filename order, each inside its
 * own transaction, each recorded in schema_migrations so it runs exactly once.
 * A file that has already been applied but whose contents changed is an error
 * rather than a silent no-op — editing an applied migration is how two
 * environments quietly stop matching.
 *
 *   npm run migrate          apply everything outstanding
 *   npm run migrate:status   list what is applied and what is not
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, MIGRATIONS_DIR } from '../config/paths.js';
import { getPool, close, connectionString } from '../server/db.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env — DATABASE_URL may still be set in the environment.
}

/**
 * Schema changes go to the direct endpoint when one is configured.
 *
 * Neon (and most managed providers) front the database with a transaction-mode
 * connection pooler. The app wants the pooled endpoint; DDL and bulk loads want
 * the direct one, which holds a real session for the whole transaction.
 */
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

const checksum = (sql) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

async function listMigrations() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return Promise.all(files.map(async (name) => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    return { name, sql, checksum: checksum(sql) };
  }));
}

async function ensureTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now()
    )`);
}

async function applied(client) {
  const { rows } = await client.query('select name, checksum from schema_migrations');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function status() {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    const all = await listMigrations();

    console.log(`\n  ${connectionString().replace(/:[^:@/]*@/, ':****@')}\n`);
    for (const m of all) {
      const was = done.get(m.name);
      const mark = !was ? 'pending' : was === m.checksum ? 'applied' : 'CHANGED';
      console.log(`  ${mark.padEnd(8)} ${m.name}`);
    }
    const pending = all.filter((m) => !done.has(m.name)).length;
    console.log(`\n  ${all.length - pending} applied, ${pending} pending\n`);
  } finally {
    client.release();
  }
}

async function run() {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    const all = await listMigrations();

    const changed = all.filter((m) => done.has(m.name) && done.get(m.name) !== m.checksum);
    if (changed.length) {
      console.error('\n  These migrations were already applied but their contents changed:');
      for (const m of changed) console.error(`    ${m.name}`);
      console.error('\n  Add a new migration instead of editing an applied one.\n');
      process.exitCode = 1;
      return;
    }

    const pending = all.filter((m) => !done.has(m.name));
    if (!pending.length) {
      console.log('\n  Nothing to apply — the database is up to date.\n');
      return;
    }

    console.log('');
    for (const m of pending) {
      process.stdout.write(`  applying ${m.name} ... `);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'insert into schema_migrations (name, checksum) values ($1, $2)',
          [m.name, m.checksum]
        );
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n  ${err.message}\n`);
        if (err.position) {
          const upto = m.sql.slice(0, Number(err.position));
          console.error(`  at line ${upto.split('\n').length} of ${m.name}\n`);
        }
        process.exitCode = 1;
        return;
      }
    }
    console.log(`\n  ${pending.length} migration(s) applied.\n`);
  } finally {
    client.release();
  }
}

const command = process.argv[2] === 'status' ? status : run;

try {
  await command();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
