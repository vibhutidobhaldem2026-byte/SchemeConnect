/**
 * Minimal robots.txt fetcher and matcher.
 *
 * Deliberately conservative: a robots.txt we cannot fetch because of a network
 * or server error is treated as "disallow", not "allow". A clean 404 means the
 * site publishes no rules, which we treat as allowed (that is what a 404 means
 * under the standard) while still applying our own rate limits.
 */

import { assertAllowed } from './allowlist.js';

const cache = new Map(); // origin -> { groups, crawlDelay, fetchedAt, status }

function parseRobots(text) {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  let current = null;
  let sawDirective = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // A new user-agent line after directives starts a fresh group.
      if (!current || sawDirective) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
        sawDirective = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current) {
      sawDirective = true;
      if (field === 'allow') current.allow.push(value);
      else if (field === 'disallow') current.disallow.push(value);
      else if (field === 'crawl-delay') {
        const n = Number(value);
        if (Number.isFinite(n)) current.crawlDelay = n;
      }
    }
  }
  return groups;
}

/** Converts a robots path pattern (supports * and $) into a RegExp. */
function patternToRegExp(pattern) {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '$') out += '$';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out);
}

function selectGroup(groups, userAgent) {
  const ua = userAgent.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        if (bestLen < 0) { best = group; bestLen = 0; }
      } else if (ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  return best;
}

/**
 * Fetches and caches robots.txt for the origin of `url`.
 * Returns { allowed: boolean, crawlDelay: number|null, reason: string }.
 */
export async function checkRobots(url, userAgent, { timeoutMs = 15000 } = {}) {
  const target = assertAllowed(url);
  const origin = target.origin;

  if (!cache.has(origin)) {
    const robotsUrl = `${origin}/robots.txt`;
    let entry;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(robotsUrl, {
        headers: { 'user-agent': userAgent, accept: 'text/plain' },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      // RFC 9309 §2.3.1:
      //   2xx "successful"   -> apply the rules
      //   4xx "unavailable"  -> no restrictions exist; crawling is permitted
      //   5xx "unreachable"  -> assume complete disallow
      if (res.ok) {
        entry = { groups: parseRobots(await res.text()), status: res.status, noRules: false };
      } else if (res.status >= 400 && res.status < 500) {
        entry = { groups: [], status: res.status, noRules: true };
      } else {
        entry = { groups: null, status: res.status, noRules: false, error: `robots.txt HTTP ${res.status} (server error — treating as disallow)` };
      }
    } catch (err) {
      /**
       * A robots.txt we cannot fetch is still treated as a disallow — but a TLS
       * chain Node refuses is not the same as a server refusing us. Several
       * ministries omit their intermediate certificate, and rejecting their
       * robots.txt on that basis blocked the whole site before the page was
       * ever requested. Chromium resolves those chains the way any visitor's
       * browser does, so the file is fetched again that way and its rules are
       * applied normally. This reads robots.txt properly; it does not skip it.
       */
      const tlsProblem =
        /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|ERR_SSL|LEGACY_RENEGOTIATION|DEPTH_ZERO_SELF_SIGNED/i
          .test(err.cause?.code || err.message || '');

      entry = null;
      if (tlsProblem) {
        try {
          const { renderPage } = await import('./browser.js');
          const rendered = await renderPage(robotsUrl, { timeoutMs: 20000 });
          if (rendered.ok) {
            // The browser returns the file wrapped in a generated HTML page.
            const text = String(rendered.body)
              .replace(/<[^>]+>/g, '')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            entry = { groups: parseRobots(text), status: 200, noRules: false, viaBrowser: true };
          } else if (/HTTP 4/.test(rendered.error ?? '')) {
            // 4xx means no rules exist, which permits crawling (RFC 9309 2.3.1.3).
            entry = { groups: [], status: 404, noRules: true, viaBrowser: true };
          }
        } catch { /* fall through to the disallow below */ }
      }

      entry ??= { groups: null, status: 0, noRules: false, error: `robots.txt fetch failed: ${err.message}` };
    }
    entry.fetchedAt = new Date().toISOString();
    cache.set(origin, entry);
  }

  const entry = cache.get(origin);
  if (entry.groups === null) {
    return { allowed: false, crawlDelay: null, reason: entry.error || 'robots.txt unavailable' };
  }
  if (entry.noRules) {
    return {
      allowed: true,
      crawlDelay: null,
      reason: `no robots.txt rules published (HTTP ${entry.status})`,
    };
  }

  const group = selectGroup(entry.groups, userAgent);
  if (!group) return { allowed: true, crawlDelay: null, reason: 'no matching robots.txt group' };

  const path = target.pathname + target.search;
  let verdict = { allowed: true, rule: '', len: -1 };
  for (const rule of group.disallow) {
    if (rule === '') continue; // "Disallow:" with empty value allows everything
    if (patternToRegExp(rule).test(path) && rule.length > verdict.len) {
      verdict = { allowed: false, rule: `Disallow: ${rule}`, len: rule.length };
    }
  }
  for (const rule of group.allow) {
    if (rule === '') continue;
    if (patternToRegExp(rule).test(path) && rule.length > verdict.len) {
      verdict = { allowed: true, rule: `Allow: ${rule}`, len: rule.length };
    }
  }

  return {
    allowed: verdict.allowed,
    crawlDelay: group.crawlDelay,
    reason: verdict.rule || 'no matching rule',
  };
}

export function robotsCacheSnapshot() {
  return [...cache.entries()].map(([origin, e]) => ({
    origin,
    status: e.status,
    hasRules: e.groups !== null && !e.noRules,
    error: e.error || null,
    fetchedAt: e.fetchedAt,
  }));
}

export function resetRobotsCache() {
  cache.clear();
}
