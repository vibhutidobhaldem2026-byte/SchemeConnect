#!/usr/bin/env node
/**
 * Connectivity probe for the configured sources.
 *
 * Government sites vary a lot in TLS configuration and bot handling, so this
 * reports, per source: robots.txt reachability, the page status, and how much
 * text the page actually yields. Use it to decide which sources are worth
 * keeping in config/sources.js.
 *
 *   node scraper/probe.js
 */

import { SOURCES } from '../config/sources.js';
import { USER_AGENT } from './lib/httpClient.js';
import { htmlToText, getLinks } from './lib/html.js';
import { checkUrl } from './lib/allowlist.js';

const TIMEOUT = 20000;

async function tryFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = res.ok ? await res.text() : '';
    return { status: res.status, body, ok: res.ok };
  } catch (err) {
    return { status: 0, body: '', ok: false, error: err.cause?.code || err.cause?.message || err.message };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const source of SOURCES) {
  const allow = checkUrl(source.url);
  if (!allow.ok) {
    results.push({ id: source.id, verdict: 'BLOCKED', detail: allow.reason });
    continue;
  }
  const origin = new URL(source.url).origin;
  const robots = await tryFetch(`${origin}/robots.txt`);
  const page = await tryFetch(source.url);

  const text = page.ok ? htmlToText(page.body) : '';
  const links = page.ok ? getLinks(page.body, source.url).filter((l) => checkUrl(l.href).ok) : [];

  results.push({
    id: source.id,
    host: new URL(source.url).hostname,
    robots: robots.status === 404 ? 'none (404, ok)' : robots.ok ? 'present' : `FAIL ${robots.error || robots.status}`,
    page: page.ok ? `${page.status}` : `FAIL ${page.error || page.status}`,
    textChars: text.length,
    govLinks: links.length,
    verdict: page.ok && text.length > 500 ? 'USABLE' : 'UNUSABLE',
  });
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log('');
console.log(pad('SOURCE', 24), pad('ROBOTS', 22), pad('PAGE', 20), pad('TEXT', 8), pad('LINKS', 6), 'VERDICT');
console.log('-'.repeat(96));
for (const r of results) {
  console.log(pad(r.id, 24), pad(r.robots, 22), pad(r.page, 20), pad(r.textChars, 8), pad(r.govLinks, 6), r.verdict);
}
console.log('');
console.log(`usable: ${results.filter((r) => r.verdict === 'USABLE').length} / ${results.length}`);
console.log('');
