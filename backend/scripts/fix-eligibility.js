#!/usr/bin/env node
/**
 * Re-reads eligibility that is stated in a scheme's own title.
 *
 *   npm run fix:eligibility -- --dry-run   show what would change
 *   npm run fix:eligibility                apply it
 *
 * The extractors only ever read the body of a page, so a scheme whose
 * restriction is in its name — "Post Matric Scholarship for Students with
 * Disabilities", "Kanya Saksharta Protsahan Yojana" — carried no restriction at
 * all and was offered to every student. Seventeen of twenty disability schemes
 * and fourteen of twenty girl-only schemes were affected.
 *
 * The crawler no longer makes that mistake, but a re-crawl costs an hour of
 * rendering and would change nothing else. Since the evidence is the title, and
 * the title is already in the database, this reads it there.
 *
 * It only ever ADDS a restriction that the name states outright. It never
 * removes one: a criterion read from the page body came from more evidence than
 * a title, and dropping it here would widen who gets shown a scheme, which is
 * the more damaging direction to be wrong in.
 */

import path from 'node:path';
import { ROOT } from '../config/paths.js';
import { extractDisability, extractGender } from '../scraper/lib/extract.js';
import { rows, query, close } from '../server/db.js';
import { log } from '../scraper/lib/log.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment.
}

const dryRun = process.argv.includes('--dry-run');

const schemes = await rows(
  `select id, name, eligibility from schemes where retired_at is null order by name`);

const changes = [];

for (const s of schemes) {
  const e = s.eligibility ?? {};
  const next = { ...e };
  const added = [];

  const disability = extractDisability('', s.name);
  if (disability?.disabilityRequired && !e.disabilityRequired) {
    next.disabilityRequired = true;
    added.push('disability');
  }

  const gender = extractGender('', s.name);
  if (gender?.gender?.length && !(e.gender ?? []).length) {
    next.gender = gender.gender;
    added.push(`gender=${gender.gender.join('/')}`);
  }

  if (added.length) changes.push({ id: s.id, name: s.name, next, added });
}

log.blank();
log.step(`${changes.length} scheme(s) state a restriction in their title that we had not recorded`);
for (const c of changes) {
  log.info(`  ${c.added.join(', ').padEnd(22)} ${c.name.slice(0, 62)}`);
}

if (!changes.length) {
  log.info('  nothing to do.');
} else if (dryRun) {
  log.blank();
  log.warn('--dry-run: nothing was written.');
} else {
  for (const c of changes) {
    await query('update schemes set eligibility = $2, updated_at = now() where id = $1',
      [c.id, JSON.stringify(c.next)]);
  }
  log.blank();
  log.step(`Updated ${changes.length} scheme(s).`);
  log.info('  These are no longer offered to students they exclude.');
}
log.blank();

await close();
