#!/usr/bin/env node
/**
 * Checks that every scheme's official link still resolves.
 *
 *   npm run check:links            check the whole catalogue
 *   npm run check:links -- 50      check the 50 least recently checked
 *
 * Records the outcome against each scheme so the site can stop showing a
 * verified badge beside a link that goes nowhere. Safe to re-run and safe to
 * interrupt: it works oldest-first, so a partial run still makes progress.
 */

import path from 'node:path';
import { ROOT } from '../config/paths.js';
import { checkCatalogueLinks } from '../scraper/linkcheck.js';
import { close, one } from '../server/db.js';
import { closeBrowser, browserWasUsed } from '../scraper/lib/browser.js';
import { log } from '../scraper/lib/log.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment.
}

const limit = Number(process.argv[2]) || 500;

const LABEL = {
  ok: 'reachable',
  redirected: 'moved',
  missing: 'gone (4xx)',
  unreachable: 'unreachable',
  forbidden: 'blocked (403)',
};

log.blank();
log.step('Checking official scheme links');
log.info('  one request per host at a time, 1s apart; no content is crawled');
log.blank();

try {
  const { checked, counts } = await checkCatalogueLinks({
    limit,
    onResult: (scheme, result) => {
      const line = `  ${scheme.name.slice(0, 46).padEnd(48)}${LABEL[result.status] ?? result.status}`;
      if (result.status === 'ok') log.debug(line);
      else log.warn(`${line}  — ${result.detail}`);
    },
  });

  log.blank();
  log.step('Result');
  for (const [status, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    log.info(`  ${String(n).padStart(4)}  ${LABEL[status] ?? status}`);
  }

  const broken = (counts.missing ?? 0) + (counts.unreachable ?? 0);
  if (broken) {
    log.blank();
    log.warn(`${broken} of ${checked} links do not resolve.`);
    log.warn('Those schemes stay browsable, but the site no longer presents their');
    log.warn('link as working. See /ops/export.json for the full picture.');
  }

  const unchecked = await one(
    `select count(*)::int as n from schemes
      where retired_at is null and apply_url <> '' and apply_url_checked_at is null`);
  if (unchecked.n) {
    log.blank();
    log.info(`${unchecked.n} scheme(s) still unchecked — run again to continue.`);
  }
  log.blank();
} catch (err) {
  log.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  if (browserWasUsed()) await closeBrowser();
  await close();
}
