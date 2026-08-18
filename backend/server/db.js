/**
 * PostgreSQL connection pool.
 *
 * The app used to keep its state in a JSON file. That was fine for a single
 * process on a laptop and impossible anywhere else: two instances overwrote
 * each other, a full disk lost a consent record silently, and every deploy on
 * an ephemeral filesystem started from zero.
 *
 * Everything a user creates now lives here. Scheme data lives here too — the
 * scraper writes it in, ops corrects it through an overlay, and nothing is read
 * from disk at runtime.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ROOT } from '../config/paths.js';

const { Pool, types } = pg;

// node-postgres returns DATE as a JS Date in the server's timezone, which
// shifts a deadline across midnight for anyone east or west of the server.
// Deadlines are calendar dates, not instants — keep them as 'YYYY-MM-DD'.
types.setTypeParser(types.builtins.DATE, (v) => v);

// numeric comes back as a string to protect precision we do not need here;
// confidence is a 0–1 score that the UI multiplies by 100.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

// bigint likewise — our counts fit in a JS number many times over.
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

let pool = null;

export function connectionString() {
  return process.env.DATABASE_URL || '';
}

/** True when a database is configured. The server refuses to start without one. */
export function isConfigured() {
  return Boolean(connectionString());
}

export function getPool() {
  if (pool) return pool;

  const url = connectionString();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. SchemeConnect stores every account, consent record and\n' +
      '  scheme in PostgreSQL. Copy .env.example to .env and point DATABASE_URL at a\n' +
      '  database, then run "npm run migrate".'
    );
  }

  pool = new Pool({
    connectionString: stripSslParams(url),
    max: Number(process.env.PGPOOL_MAX || 10),
    // Below the idle cutoff of a typical managed pooler. Neon in particular
    // scales its compute to zero and drops connections; holding one for half a
    // minute means handing a dead socket to the next request.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    // Managed providers (Supabase, Neon, RDS) terminate TLS with their own CA.
    // Opt in explicitly rather than disabling verification everywhere.
    ssl: sslConfig(url),
  });

  // A pool error is emitted for idle clients dropped by the server. Without a
  // listener Node treats it as an unhandled 'error' event and exits.
  pool.on('error', (err) => {
    console.error('postgres pool error:', err.message);
  });

  return pool;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

/**
 * Removes TLS parameters from the connection string.
 *
 * node-postgres derives its own ssl settings from `sslmode` in the URL, and
 * those win over the `ssl` object passed alongside it — so a URL copied from a
 * provider's dashboard silently overrides everything below, including a pinned
 * CA. Stripping them leaves sslConfig() as the single source of truth.
 */
function stripSslParams(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * TLS settings for the connection.
 *
 * Some providers — Supabase among them — issue their database certificates
 * from their own CA rather than a publicly trusted one, so the default trust
 * store rejects them. The fix is to pin that CA, not to stop checking:
 * point PGSSL_CA_FILE at the certificate from the provider's dashboard and
 * the chain is verified properly, hostname included.
 *
 * PGSSL_NO_VERIFY=true encrypts without verifying. It is a stopgap for getting
 * running before the certificate is in place, and it leaves the connection open
 * to an attacker who can intercept it. The server warns while it is set.
 */
function sslConfig(url) {
  if (process.env.PGSSL === 'disable') return false;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sslmode') === 'disable') return false;
    // Local development, over a unix socket or loopback, needs no TLS.
    if (LOCAL_HOSTS.has(parsed.hostname)) return false;
  } catch {
    // Not a URL we can parse — let pg deal with it and keep TLS on.
  }

  const caFile = process.env.PGSSL_CA_FILE;
  if (caFile) {
    // Relative to the backend root, not the working directory: a deploy may
    // start the process from anywhere.
    const resolved = path.isAbsolute(caFile) ? caFile : path.join(ROOT, caFile);
    return { ca: readFileSync(resolved, 'utf8'), rejectUnauthorized: true };
  }

  return { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== 'true' };
}

/** True when the connection is encrypted but the certificate is not checked. */
export function tlsIsUnverified() {
  return !process.env.PGSSL_CA_FILE
    && process.env.PGSSL_NO_VERIFY === 'true'
    && process.env.PGSSL !== 'disable';
}

/**
 * Connection-level failures, as opposed to anything the statement did wrong.
 *
 * A serverless database that scales to zero produces these routinely: the
 * socket is gone before the query is answered.
 */
const CONNECTION_ERRORS = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now — the compute is still waking
  '08006', // connection_failure
  '08003', // connection_does_not_exist
]);

const isConnectionError = (err) =>
  CONNECTION_ERRORS.has(err?.code) || /Connection terminated/i.test(err?.message ?? '');

/** A read is safe to repeat; a write is not, because it may already have applied. */
const isReadOnly = (text) => /^\s*(select|with)\b/i.test(text) && !/\b(insert|update|delete)\b/i.test(text);

/**
 * Runs one statement. Parameters are always bound, never interpolated.
 *
 * A read that fails on a dropped connection is retried once — the query never
 * reached the server, or its answer never came back, and repeating a select
 * changes nothing. Writes are never retried: a reset after an insert leaves us
 * unable to tell whether it committed, and a duplicate consent record or a
 * doubled batch import is worse than an error.
 */
export async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    if (isConnectionError(err) && isReadOnly(text)) {
      return getPool().query(text, params);
    }
    throw err;
  }
}

/** Convenience: the rows of a query. */
export async function rows(text, params) {
  return (await query(text, params)).rows;
}

/**
 * Builds a multi-row VALUES list and its parameter array.
 *
 * One statement per chunk instead of one per row. On a local database the
 * difference is invisible; against a managed database a few hundred kilometres
 * away every row costs a round trip, and a batch import turns into thousands of
 * them.
 */
export function valuesList(rowsOfParams, startAt = 1) {
  const params = [];
  let n = startAt;
  const tuples = rowsOfParams.map((row) => {
    const placeholders = row.map(() => `$${n++}`);
    params.push(...row);
    return `(${placeholders.join(', ')})`;
  });
  return { text: tuples.join(', '), params };
}

/** Splits a list into fixed-size groups. PostgreSQL caps a statement at 65535
 *  bound parameters, so a large insert has to be chunked. */
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Convenience: the first row, or null. */
export async function one(text, params) {
  return (await query(text, params)).rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * Used where a half-written result would be worse than an error: creating an
 * account and its consent record, and importing a batch of students.
 */
export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Verifies the database is reachable and migrated. Used by startup and /healthz. */
export async function healthcheck() {
  const { rows: r } = await query(
    `select count(*)::int as applied from schema_migrations`
  );
  return { ok: true, migrations: r[0].applied };
}

export async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
