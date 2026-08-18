#!/usr/bin/env node
/**
 * SchemeConnect scraper CLI.
 *
 *   npm run scrape              full run, writes data/catalog/schemes.json
 *   npm run scrape -- --dry-run crawl and report, write nothing
 *   npm run scrape -- --source nsp-home   run a single source
 *   npm run scrape -- --limit 5           cap candidates per source
 *   npm run scrape -- --no-cache          ignore the on-disk response cache
 *
 * Writes three artefacts the website reads:
 *   schemes.json      the catalog
 *   coverage.json     which states we can and cannot serve
 *   scrape-runs.json  run history for the ops dashboard
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, CATALOG_DIR, CATALOG_FILE, COVERAGE_FILE, RUN_LOG_FILE } from '../config/paths.js';
import { SOURCES, ENABLED_SOURCES } from '../config/sources.js';
import { checkUrl, ALLOWLIST_DESCRIPTION } from './lib/allowlist.js';
import { robotsCacheSnapshot } from './lib/robots.js';
import { cacheStats } from './lib/cache.js';
import { dedupeSchemes, validateScheme } from './lib/normalize.js';
import { STATES } from './lib/extract.js';
import { log } from './lib/log.js';
import govHtml, { nspAdapter } from './adapters/govHtml.js';
import govPdf from './adapters/govPdf.js';
import { startRun, finishRun, publish, existingSchemeCount } from './publish.js';
import { close as closeDb, isConfigured } from '../server/db.js';

// The catalogue is published to PostgreSQL, so a crawl needs a connection.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment.
}

const ADAPTERS = {
  'gov-html': govHtml,
  'nsp-html': nspAdapter,
  'gov-pdf': govPdf,
};

function parseArgs(argv) {
  const args = { dryRun: false, source: null, limit: null, useCache: true, reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--report-only') args.reportOnly = true;
    else if (a === '--no-cache') args.useCache = false;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--verbose') log.setLevel('debug');
  }
  return args;
}

async function crawlSource(source, args, stats) {
  log.step(`${source.label}`);
  log.info(`  ${source.url}`);

  const adapter = ADAPTERS[source.adapter];
  if (!adapter) {
    log.error(`  unknown adapter "${source.adapter}"`);
    stats.sourceErrors.push({ source: source.id, error: `unknown adapter ${source.adapter}` });
    return [];
  }

  const { candidates, listings = [], error } = await adapter.discover(source);
  if (error) {
    log.warn(`  discovery failed: ${error}`);
    stats.sourceErrors.push({ source: source.id, error });
    return [];
  }

  const schemes = [];

  // Tier 1 — names published directly on the government listing page. These
  // have an authoritative name and official link but no criteria.
  let keptListings = 0;
  for (const listing of listings) {
    const { valid, problems } = validateScheme(listing);
    if (!valid) {
      stats.rejected.push({ url: listing.source.url, name: listing.name, reason: `listing: ${problems.join('; ')}` });
      continue;
    }
    listing.sourceId = source.id;
    schemes.push(listing);
    keptListings++;
  }
  if (listings.length) {
    log.info(`  ${keptListings} scheme name(s) from the listing page (no criteria yet)`);
  }

  // Tier 2 — follow links to detail pages and circulars for real criteria.
  const capped = args.limit ? candidates.slice(0, args.limit) : candidates;
  log.info(`  ${candidates.length} candidate link(s)${capped.length !== candidates.length ? `, capped to ${capped.length}` : ''}`);
  if (!capped.length) {
    log.info(`  kept ${schemes.length}`);
    log.blank();
    return schemes;
  }

  for (const candidate of capped) {
    stats.candidatesSeen++;
    const useAdapter = candidate.isPdf ? govPdf : adapter;
    let result = await useAdapter.extract(candidate);

    // An HTML URL that turned out to serve a PDF gets one retry via the PDF path.
    if (result.retryAsPdf) result = await govPdf.extract(candidate);

    if (result.error || !result.scheme) {
      stats.rejected.push({ url: candidate.url, reason: result.error || 'no scheme produced' });
      log.debug(`  skip ${candidate.url} — ${result.error}`);
      continue;
    }

    const { valid, problems } = validateScheme(result.scheme);
    if (!valid) {
      stats.rejected.push({ url: candidate.url, reason: problems.join('; '), name: result.scheme.name });
      log.debug(`  drop "${result.scheme.name}" — ${problems.join('; ')}`);
      continue;
    }

    result.scheme.sourceId = source.id;
    schemes.push(result.scheme);
    log.ok(`  ${result.scheme.name}  [confidence ${result.scheme.confidence}]`);
  }

  log.info(`  kept ${schemes.length} total (${schemes.filter((s) => s.detailLevel === 'full').length} with criteria)`);
  log.blank();
  return schemes;
}

/** Which states we can honestly serve, per the PRD's show-nothing-rather-than-mislead rule. */
function buildCoverage(schemes) {
  const byState = new Map();
  for (const state of STATES) byState.set(state, { state, schemes: 0, central: 0 });

  const centralCount = schemes.filter((s) => s.level === 'central').length;
  for (const entry of byState.values()) entry.central = centralCount;

  for (const scheme of schemes) {
    if (scheme.level !== 'state') continue;
    const targets = scheme.eligibility.states.length ? scheme.eligibility.states : (scheme.state ? [scheme.state] : []);
    for (const st of targets) {
      const entry = byState.get(st);
      if (entry) entry.schemes++;
    }
  }

  const covered = [...byState.values()].filter((e) => e.schemes > 0 || e.central > 0);
  const uncovered = [...byState.values()].filter((e) => e.schemes === 0 && e.central === 0);

  return {
    generatedAt: new Date().toISOString(),
    totalStates: STATES.length,
    statesWithStateSchemes: [...byState.values()].filter((e) => e.schemes > 0).map((e) => e.state),
    statesWithoutStateSchemes: [...byState.values()].filter((e) => e.schemes === 0).map((e) => e.state),
    centralSchemes: centralCount,
    perState: [...byState.values()],
    coveredCount: covered.length,
    uncoveredCount: uncovered.length,
  };
}

async function appendRunLog(entry) {
  let history = [];
  try {
    history = JSON.parse(await readFile(RUN_LOG_FILE, 'utf8'));
  } catch {
    history = [];
  }
  history.unshift(entry);
  await writeFile(RUN_LOG_FILE, JSON.stringify(history.slice(0, 30), null, 2), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  log.blank();
  log.step('SchemeConnect scraper');
  log.info(`  policy: ${ALLOWLIST_DESCRIPTION}`);
  log.info(`  robots.txt respected · requests serialised per host · min 2s between hits`);
  if (args.dryRun) log.warn('  DRY RUN — no files will be written');
  log.blank();

  // Static allowlist check before any network activity.
  // --source names an explicit source and may target a disabled one on purpose.
  const sources = args.source
    ? SOURCES.filter((s) => s.id === args.source)
    : ENABLED_SOURCES;
  if (!sources.length) {
    log.error(`no source matched "${args.source}"`);
    process.exitCode = 1;
    return;
  }

  const skipped = args.source ? [] : SOURCES.filter((s) => s.enabled === false);
  if (skipped.length) {
    log.info(`  ${skipped.length} source(s) disabled in config:`);
    for (const s of skipped) log.info(`    ${s.id} — ${s.disabledReason}`);
    log.blank();
  }
  const blocked = sources.filter((s) => !checkUrl(s.url).ok);
  if (blocked.length) {
    for (const s of blocked) log.error(`source "${s.id}" is not a permitted target: ${checkUrl(s.url).reason}`);
    log.error('Refusing to run. Every source must be a government domain.');
    process.exitCode = 1;
    return;
  }
  log.ok(`${sources.length} source(s) passed the government-domain check`);
  log.blank();

  const stats = { candidatesSeen: 0, rejected: [], sourceErrors: [] };
  const all = [];
  for (const source of sources) {
    all.push(...(await crawlSource(source, args, stats)));
  }

  const schemes = dedupeSchemes(all).sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  const coverage = buildCoverage(schemes);
  const finishedAt = new Date();

  log.blank();
  log.step('Run summary');
  log.info(`  sources crawled     ${sources.length}`);
  log.info(`  candidates examined ${stats.candidatesSeen}`);
  log.info(`  schemes kept        ${schemes.length}`);
  log.info(`  rejected            ${stats.rejected.length}`);
  log.info(`  source failures     ${stats.sourceErrors.length}`);
  log.info(`  duration            ${Math.round((finishedAt - startedAt) / 1000)}s`);
  const cs = await cacheStats();
  log.info(`  cache               ${cs.entries} entries, ${(cs.bytes / 1024 / 1024).toFixed(1)} MB`);

  if (stats.sourceErrors.length) {
    log.blank();
    log.warn('Sources that failed:');
    for (const e of stats.sourceErrors) log.warn(`  ${e.source}: ${e.error}`);
  }

  const runEntry = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt - startedAt) / 1000),
    sourcesCrawled: sources.map((s) => s.id),
    sourcesDisabled: SOURCES.filter((s) => s.enabled === false)
      .map((s) => ({ id: s.id, label: s.label, reason: s.disabledReason })),
    candidatesExamined: stats.candidatesSeen,
    schemesKept: schemes.length,
    rejectedCount: stats.rejected.length,
    rejected: stats.rejected.slice(0, 100),
    sourceErrors: stats.sourceErrors,
    robots: robotsCacheSnapshot(),
    dryRun: args.dryRun,
  };

  if (args.dryRun) {
    log.blank();
    log.warn('Dry run — nothing written.');
    return;
  }

  await mkdir(CATALOG_DIR, { recursive: true });

  // Never replace a good catalog with an empty one: a total crawl failure
  // should leave the site serving the last known-good data, flagged as stale.
  if (schemes.length === 0) {
    // Never replace a good catalogue with an empty one, in either store.
    const inDb = isConfigured() ? await existingSchemeCount() : 0;
    let existing = null;
    try {
      existing = JSON.parse(await readFile(CATALOG_FILE, 'utf8'));
    } catch { /* no previous catalog */ }
    if (inDb > 0) {
      log.blank();
      log.warn(`Crawl produced 0 schemes — keeping the published catalogue of ${inDb}.`);
      log.warn('The site will show these as stale rather than showing nothing.');
      const runId = (await startRun('scrape')).id;
      await finishRun(runId, { ok: false, stats: runEntry, rejections: [{ error: 'crawl produced 0 schemes' }] });
      await appendRunLog({ ...runEntry, outcome: 'kept-previous-catalog' });
      return;
    }
    if (existing?.schemes?.length) {
      log.blank();
      log.warn(`Crawl produced 0 schemes — keeping the existing catalog of ${existing.schemes.length}.`);
      log.warn('The site will show these as stale rather than showing nothing.');
      await appendRunLog({ ...runEntry, outcome: 'kept-previous-catalog' });
      return;
    }
  }

  await writeFile(
    CATALOG_FILE,
    JSON.stringify(
      {
        generatedAt: finishedAt.toISOString(),
        generatedBy: 'schemeconnect-scraper/0.1',
        policy: ALLOWLIST_DESCRIPTION,
        sourceCount: sources.length,
        schemeCount: schemes.length,
        schemes,
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(COVERAGE_FILE, JSON.stringify(coverage, null, 2), 'utf8');
  await appendRunLog({ ...runEntry, outcome: 'written' });

  log.blank();
  log.ok(`Catalog exported: ${CATALOG_FILE}`);
  log.ok(`Coverage exported: ${COVERAGE_FILE}`);

  // The site reads from PostgreSQL, not from those files. They stay as an
  // offline export so a fresh checkout has something to import.
  if (!isConfigured()) {
    log.warn('DATABASE_URL is not set — wrote the export files but published nothing.');
    log.warn('Set it and run "npm run import:catalog" to load them.');
    log.blank();
    return;
  }

  const runId = (await startRun('scrape')).id;
  try {
    const published = await publish({
      runId,
      schemes,
      sources: sources.map((src) => ({
        id: src.id,
        status: src.error ? 'error' : 'ok',
        error: src.error ?? null,
      })),
    });
    await finishRun(runId, { ok: true, stats: runEntry, rejections: runEntry.rejections ?? [] });

    log.ok(`Published to the database: ${published.full + published.listing} schemes `
      + `(${published.full} matchable, ${published.listing} listing-only)`);
    if (published.retired) {
      log.warn(`${published.retired} scheme(s) no longer found at their source — retired, not deleted.`);
    }
  } catch (err) {
    await finishRun(runId, { ok: false, stats: runEntry, rejections: [{ error: err.message }] });
    throw err;
  }
  log.blank();
}

main()
  .catch((err) => {
    log.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
