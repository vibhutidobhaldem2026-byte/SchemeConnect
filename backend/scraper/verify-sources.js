#!/usr/bin/env node
/**
 * Static check that every configured source is a permitted government target.
 * Runs without touching the network — use it in CI or before a crawl.
 */

import { SOURCES } from '../config/sources.js';
import { checkUrl, ALLOWLIST_DESCRIPTION } from './lib/allowlist.js';
import { log } from './lib/log.js';

log.blank();
log.step('Source allowlist verification');
log.info(`  policy: ${ALLOWLIST_DESCRIPTION}`);
log.blank();

let failures = 0;
for (const source of SOURCES) {
  const result = checkUrl(source.url);
  if (result.ok) {
    log.ok(`${source.id.padEnd(26)} ${result.url.hostname}`);
  } else {
    failures++;
    log.error(`${source.id.padEnd(26)} ${source.url}`);
    log.error(`   ${result.reason}`);
  }
}

log.blank();
if (failures) {
  log.error(`${failures} source(s) are not permitted government targets.`);
  process.exitCode = 1;
} else {
  log.ok(`All ${SOURCES.length} sources are government domains.`);
}
log.blank();
