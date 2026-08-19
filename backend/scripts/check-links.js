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
import { close, one, query } from '../server/db.js';
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

  /**
   * Retire what no longer resolves.
   *
   * A scheme whose official page is gone cannot be applied for, and leaving it
   * browsable means a student finds it, reads it, and hits a dead end — the
   * late-stage failure the research called the most severe symptom of all. It
   * is retired rather than deleted: someone may have saved it, stored batch
   * matches reference it by foreign key, and if the ministry puts the page back
   * the next crawl un-retires it automatically.
   *
   * Only 4xx and unreachable count. A 403 means a server refused a bot, which
   * says nothing about whether a person can open the page.
   */
  const { rowCount: retired } = await query(
    `update schemes set retired_at = now()
      where retired_at is null and apply_url_status in ('missing', 'unreachable')`);
  if (retired) {
    log.blank();
    log.warn(`${retired} scheme(s) retired — their official page no longer resolves.`);
    log.warn('Retired, not deleted: a page that comes back is picked up by the next crawl.');
  }

  const broken = (counts.missing ?? 0) + (counts.unreachable ?? 0);
  if (broken) {
    log.info(`${broken} of ${checked} links did not resolve on this pass.`);
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
