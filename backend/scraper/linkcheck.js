/**
 * Verifies that the links we send students to actually go somewhere.
 *
 * The catalogue promises every scheme carries an official government link with
 * a verified badge. A sample found about a quarter of them dead — one ministry
 * host had no DNS record at all — while the badge still said verified. This
 * records what each link really does so the UI can stop claiming otherwise.
 *
 * Deliberately NOT a crawl. It fetches no content and follows no links; it asks
 * whether one URL responds, because that is what a person clicking it will
 * experience. robots.txt governs crawling, and a robots file we cannot read
 * says nothing about whether a page loads in a browser — conflating the two is
 * what would make a perfectly good link look broken. Requests are still
 * serialised per host with a gap between them, for the same reason the crawler
 * is polite.
 */

import { checkUrl } from './lib/allowlist.js';
import { query, rows } from '../server/db.js';

const USER_AGENT =
  'SchemeConnectBot/0.1 (+https://schemeconnect.com/bot; link check; contact support@schemeconnect.com)';

const MIN_GAP_MS = 1000;
const TIMEOUT_MS = 15000;

/** host -> promise chain tail, so one host is never hit concurrently. */
const hostQueues = new Map();

function perHost(host, task) {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const result = await task();
      await new Promise((r) => setTimeout(r, MIN_GAP_MS));
      return result;
    });
  hostQueues.set(host, next.catch(() => {}));
  return next;
}

/**
 * Classifies one URL.
 *
 * @returns {{status: string, detail: string}}
 */
export async function checkLink(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { status: 'missing', detail: 'not a valid URL' };
  }

  // We only ever link to government pages; anything else is a bug upstream.
  const allowed = checkUrl(url);
  if (!allowed.ok) return { status: 'forbidden', detail: allowed.reason };

  return perHost(target.hostname, async () => {
    // HEAD first — it asks the same question without transferring the page.
    // Plenty of government servers reject it, so fall back to a GET.
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(target.href, {
          method,
          redirect: 'follow',
          headers: { 'user-agent': USER_AGENT, accept: '*/*' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (res.status === 405 || res.status === 501) continue; // method refused

        if (res.status === 403) return { status: 'forbidden', detail: 'HTTP 403' };
        if (res.status >= 400 && res.status < 500) {
          return { status: 'missing', detail: `HTTP ${res.status}` };
        }
        if (res.status >= 500) {
          return { status: 'unreachable', detail: `HTTP ${res.status}` };
        }

        const moved = res.url && res.url !== target.href;
        return moved
          ? { status: 'redirected', detail: `now at ${res.url}` }
          : { status: 'ok', detail: `HTTP ${res.status}` };
      } catch (err) {
        const code = err.cause?.code || err.name || err.message;
        // A refused HEAD sometimes surfaces as a socket error; let GET decide.
        if (method === 'HEAD') continue;
        return {
          status: 'unreachable',
          detail: code === 'ENOTFOUND' ? 'host does not resolve' : String(code),
        };
      }
    }
    return { status: 'unreachable', detail: 'no response to HEAD or GET' };
  });
}

/**
 * Checks the catalogue's links, oldest first so it can be resumed.
 *
 * @param {{limit?: number, concurrency?: number, onResult?: Function}} options
 */
export async function checkCatalogueLinks({ limit = 500, concurrency = 6, onResult } = {}) {
  const schemes = await rows(
    `select id, name, apply_url from schemes
      where retired_at is null and apply_url <> ''
      order by apply_url_checked_at nulls first
      limit $1`,
    [limit]
  );

  const counts = {};
  let index = 0;

  async function worker() {
    while (index < schemes.length) {
      const scheme = schemes[index++];
      const result = await checkLink(scheme.apply_url);
      counts[result.status] = (counts[result.status] ?? 0) + 1;

      await query(
        `update schemes
            set apply_url_status = $2, apply_url_detail = $3, apply_url_checked_at = now()
          where id = $1`,
        [scheme.id, result.status, result.detail.slice(0, 300)]
      );

      onResult?.(scheme, result);
    }
  }

  // Concurrency across hosts; the per-host queue keeps each individual server
  // to one request at a time.
  await Promise.all(Array.from({ length: concurrency }, worker));

  return { checked: schemes.length, counts };
}
