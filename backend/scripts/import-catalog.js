/**
 * One-time load of the file catalogue into PostgreSQL.
 *
 * The catalogue used to live in data/catalog/*.json, committed to git and read
 * from disk on every request. This moves it into the database so ops can
 * correct a scheme without a redeploy. After this runs, the scraper writes
 * straight to the database and the JSON files are only a dev-time export.
 *
 * Safe to re-run: schemes are upserted by id, sources by id.
 *
 *   npm run import:catalog
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, CATALOG_FILE, RUN_LOG_FILE } from '../config/paths.js';
import { SOURCES } from '../config/sources.js';
import { transaction, query, close } from '../server/db.js';
import { publish } from '../scraper/publish.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment instead.
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Hostname of a source URL, so a scheme row can be traced to its domain. */
function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function importSources(client) {
  for (const s of SOURCES) {
    await client.query(
      `insert into sources (id, url, domain, adapter, level, state, enabled, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update
         set url = excluded.url, domain = excluded.domain, adapter = excluded.adapter,
             level = excluded.level, state = excluded.state,
             enabled = excluded.enabled, note = excluded.note`,
      [
        s.id,
        s.url,
        domainOf(s.url) ?? 'unknown',
        s.adapter,
        s.level === 'state' ? 'state' : 'central',
        s.state ?? null,
        s.enabled !== false,
        // An unreachable source keeps its reason rather than being deleted.
        s.disabledReason ?? s.label ?? null,
      ]
    );
  }
  return SOURCES.length;
}

async function importRuns(client, runs) {
  // Seeded once. Re-running the import should not duplicate the history — the
  // run log is a record of crawls, and this script performs no crawl.
  const { rows: [existing] } = await client.query(
    'select count(*)::int as n from scrape_runs');
  if (existing.n > 0) {
    const { rows } = await client.query(
      'select id from scrape_runs order by started_at desc limit 1');
    return rows.map((r) => r.id);
  }

  // Newest last, so the most recent run ends up with the latest started_at.
  const ordered = [...runs].reverse();
  const ids = [];
  for (const run of ordered) {
    const { startedAt, finishedAt, ok, rejections, ...stats } = run;
    const { rows: [row] } = await client.query(
      `insert into scrape_runs (started_at, finished_at, ok, stats, rejections)
       values (coalesce($1::timestamptz, now()), $2, $3, $4, $5)
       returning id`,
      [
        startedAt ?? null,
        finishedAt ?? startedAt ?? null,
        ok ?? true,
        JSON.stringify(stats ?? {}),
        JSON.stringify(rejections ?? []),
      ]
    );
    ids.push(row.id);
  }
  return ids;
}

// ------------------------------------------------------------------ run ----

const catalog = await readJson(CATALOG_FILE, null);
if (!catalog?.schemes?.length) {
  console.error('\n  No catalogue at data/catalog/schemes.json — run "npm run scrape" first.\n');
  process.exit(1);
}
const runLog = await readJson(RUN_LOG_FILE, []);

console.log('');
try {
  // Sources and run history first, so schemes can reference them.
  const { sources, runs, latestRun } = await transaction(async (client) => {
    const count = await importSources(client);
    const runIds = await importRuns(client, runLog);
    return { sources: count, runs: runIds.length, latestRun: runIds.at(-1) ?? null };
  });

  // Schemes go through the scraper's own publisher rather than a second copy of
  // the same upsert. Nothing here writes the catalogue differently from a crawl.
  const counts = await publish({ runId: latestRun, schemes: catalog.schemes });
  const result = { sources, runs, ...counts };

  // Foreign keys deferred nothing, so any scheme referencing a source id that
  // is not in config is left unlinked rather than blocking the import.
  const { rows: orphaned } = await query(
    `select count(*)::int as n from schemes where source_id is null`);

  console.log(`  sources   ${result.sources}`);
  console.log(`  runs      ${result.runs}`);
  console.log(`  schemes   ${result.full + result.listing} (${result.full} matchable, ${result.listing} listing-only)`);
  if (orphaned[0].n) console.log(`  unlinked  ${orphaned[0].n} scheme(s) have no source row`);
  console.log('\n  Catalogue imported.\n');
} catch (err) {
  console.error(`  Import failed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
