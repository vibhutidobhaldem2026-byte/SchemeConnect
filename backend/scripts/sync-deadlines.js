#!/usr/bin/env node
/**
 * Fills in application deadlines from the National Scholarship Portal.
 *
 *   npm run sync:deadlines
 *
 * Not one scheme in the catalogue had a deadline. Ministry pages and scheme
 * directories describe what a scheme is and who it is for; none of them says
 * the window closes on 31 October. NSP's "All Scholarships" index does, one row
 * per scheme, because it is the portal you actually apply through.
 *
 * This reads that index and writes the dates onto schemes we already hold. It
 * deliberately does NOT create schemes: an index row is a name and two dates,
 * with no eligibility, and adding it as a new entry would duplicate what the
 * scheme directories already describe properly.
 *
 * Matching is on the scheme name, normalised. A wrong match would put a real
 * closing date on the wrong scholarship and send a student to a window that was
 * never theirs, so the bar is deliberately high: near-exact after normalisation,
 * or nothing.
 */

import path from 'node:path';
import { ROOT } from '../config/paths.js';
import * as nspIndex from '../scraper/adapters/nspIndex.js';
import { rows, query, close } from '../server/db.js';
import { log } from '../scraper/lib/log.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment.
}

const INDEX_URL = 'https://scholarships.gov.in/All-Scholarships';

/**
 * Strips everything that varies between how two sites write the same name:
 * punctuation, the words "scheme"/"scholarship", bracketed qualifiers, and the
 * ministry prefixes NSP adds ("AICTE - ...").
 */
function normalise(name) {
  return String(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(scheme|scholarship|scholarships|for|the|of|and|to|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word overlap, as a share of the smaller name. */
function similarity(a, b) {
  const wa = new Set(normalise(a).split(' ').filter((w) => w.length > 2));
  const wb = new Set(normalise(b).split(' ').filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

/** A match has to be this close, and clearly better than the runner-up. */
const MIN_SIMILARITY = 0.8;
const MIN_MARGIN = 0.15;

log.blank();
log.step('Syncing application deadlines from the National Scholarship Portal');

try {
  const { candidates, error } = await nspIndex.discover({
    id: 'nsp-all-scholarships', url: INDEX_URL, level: 'central', maxLinks: 200,
  });
  if (error) throw new Error(error);

  // Name -> deadline, from the index.
  const windows = [];
  for (const candidate of candidates) {
    const { scheme } = await nspIndex.extract(candidate);
    if (scheme?.deadline) windows.push({ name: scheme.name, deadline: scheme.deadline });
  }
  log.info(`  ${windows.length} scheme(s) on NSP state an application window`);

  const catalogue = await rows(
    "select id, name, deadline from schemes where retired_at is null");
  log.info(`  ${catalogue.length} scheme(s) in the catalogue to match against`);

  let updated = 0;
  let alreadySet = 0;
  const ambiguous = [];

  for (const scheme of catalogue) {
    const scored = windows
      .map((w) => ({ ...w, score: similarity(scheme.name, w.name) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < MIN_SIMILARITY) continue;

    // A name that matches two NSP rows nearly equally is not a match at all.
    const runnerUp = scored[1]?.score ?? 0;
    if (best.score - runnerUp < MIN_MARGIN && runnerUp >= MIN_SIMILARITY) {
      ambiguous.push(scheme.name);
      continue;
    }

    if (scheme.deadline === best.deadline) { alreadySet++; continue; }

    await query('update schemes set deadline = $2, updated_at = now() where id = $1',
      [scheme.id, best.deadline]);
    updated++;
    log.info(`  ${best.deadline}  ${scheme.name.slice(0, 52)}`);
  }

  log.blank();
  log.step('Result');
  log.info(`  ${updated} scheme(s) given a deadline`);
  if (alreadySet) log.info(`  ${alreadySet} already had the right one`);
  if (ambiguous.length) {
    log.warn(`  ${ambiguous.length} skipped as ambiguous — two NSP rows matched equally well:`);
    for (const name of ambiguous.slice(0, 5)) log.warn(`      ${name.slice(0, 60)}`);
    log.warn('  Left alone deliberately: a wrong deadline is worse than none.');
  }

  const [{ n }] = await rows(
    'select count(*)::int as n from schemes where retired_at is null and deadline is not null');
  log.blank();
  log.info(`  the catalogue now has ${n} scheme(s) with a stated deadline`);
  log.blank();
} catch (err) {
  log.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await close();
}
