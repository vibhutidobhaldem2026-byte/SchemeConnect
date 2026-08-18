#!/usr/bin/env node
/**
 * Dev tool: dump what the scraper actually sees on one government page.
 *
 *   node scraper/inspect.js <url>
 *
 * Useful when a source yields nothing and you need to know whether the problem
 * is the fetch, the page structure, or the extraction heuristics.
 */

import { govFetch } from './lib/httpClient.js';
import { getTables, getHeadings, getLinks, htmlToText, sectionAfterHeading } from './lib/html.js';
import { extractAll } from './lib/extract.js';
import { checkUrl } from './lib/allowlist.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scraper/inspect.js <government-url>');
  process.exit(1);
}

const allow = checkUrl(url);
if (!allow.ok) {
  console.error(`Blocked: ${allow.reason}`);
  process.exit(1);
}

const res = await govFetch(url);
console.log(`status ${res.status} · ${res.contentType} · ${res.body.length} bytes · cache=${res.fromCache}`);

const tables = getTables(res.body);
console.log(`\n=== TABLES (${tables.length})`);
tables.slice(0, 3).forEach((t, i) => {
  console.log(`-- table ${i}: ${t.length} rows x ${t[0]?.length ?? 0} cols`);
  t.slice(0, 8).forEach((r) => console.log('   ', r.map((c) => c.slice(0, 38)).join(' | ')));
});

console.log('\n=== HEADINGS');
getHeadings(res.body).slice(0, 25).forEach((h) => console.log(`  h${h.level}: ${h.text.slice(0, 90)}`));

const links = getLinks(res.body, res.url).filter((l) => checkUrl(l.href).ok);
console.log(`\n=== GOV LINKS (${links.length})`);
links.slice(0, 20).forEach((l) => console.log(`  ${l.text.slice(0, 50).padEnd(52)} ${l.href.slice(0, 80)}`));

const text = htmlToText(res.body);
console.log(`\n=== TEXT (${text.length} chars)`);
console.log(text.slice(0, 2000));

console.log('\n=== "ELIGIBILITY" SECTION');
console.log(sectionAfterHeading(res.body, /eligib/i).slice(0, 1200) || '(none found)');

console.log('\n=== EXTRACTED');
console.dir(extractAll(text), { depth: 4 });
