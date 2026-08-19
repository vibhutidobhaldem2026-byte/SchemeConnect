/**
 * Polite HTTP client for government sources.
 *
 * Every fetch passes through, in order:
 *   1. the government-domain allowlist (throws on anything else)
 *   2. robots.txt for that origin
 *   3. a per-host rate limiter (serialised, with a minimum delay between hits)
 *   4. an on-disk response cache
 *
 * We identify ourselves honestly in the User-Agent and never parallelise
 * requests against a single host.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { assertAllowed } from './allowlist.js';
import { checkRobots } from './robots.js';
import { readCache, writeCache } from './cache.js';
import { log } from './log.js';

export const USER_AGENT =
  'SchemeConnectBot/0.1 (+https://schemeconnect.com/bot; scholarship discovery for students; contact support@schemeconnect.com)';

const DEFAULT_MIN_DELAY_MS = 2000; // never hit the same host faster than this
const MAX_ATTEMPTS = 3;

/** host -> Promise chain tail, so requests to one host run strictly in series. */
const hostQueues = new Map();
/** host -> timestamp of last completed request. */
const lastHit = new Map();

export class FetchBlockedError extends Error {
  constructor(url, reason) {
    super(`Fetch blocked for ${url}: ${reason}`);
    this.name = 'FetchBlockedError';
    this.url = url;
    this.reason = reason;
  }
}

function enqueue(host, task) {
  const prev = hostQueues.get(host) || Promise.resolve();
  // Swallow the previous task's rejection so one failure doesn't poison the chain.
  const next = prev.catch(() => {}).then(task);
  hostQueues.set(host, next.catch(() => {}));
  return next;
}

async function respectDelay(host, minDelayMs) {
  const last = lastHit.get(host);
  if (last !== undefined) {
    const waited = Date.now() - last;
    if (waited < minDelayMs) await sleep(minDelayMs - waited);
  }
}

/**
 * Fetches a government URL as text (HTML/XML/JSON) or bytes.
 *
 * @returns {Promise<{ok:boolean, status:number, url:string, body:string|Buffer,
 *                     contentType:string, fromCache:boolean, fetchedAt:string}>}
 */
export async function govFetch(rawUrl, options = {}) {
  const {
    binary = false,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    timeoutMs = 30000,
    useCache = true,
    cacheTtlMs = 1000 * 60 * 60 * 12,
    accept = binary ? 'application/pdf,*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    method = 'GET',
    form = null,
    cookie = null,
  } = options;

  /**
   * A few portals only answer a POST.
   *
   * NSP's scheme directory is one: the whole catalogue sits behind three form
   * endpoints and there is no URL that lists it. Routing that through here
   * rather than a bare fetch in the adapter is deliberate — this function is
   * the one place that checks the host is a government domain, honours
   * robots.txt and paces requests, and a source that skipped it would quietly
   * skip all three.
   *
   * The response is never cached. The cache is keyed by URL alone, so two
   * POSTs to the same endpoint with different bodies would read each other's
   * answers — every ministry returning whichever one ran first.
   */
  const isPost = method.toUpperCase() === 'POST';
  const cacheable = useCache && !isPost;

  const url = assertAllowed(rawUrl); // hard boundary — throws on non-gov hosts
  const host = url.hostname;

  if (cacheable) {
    const cached = await readCache(url.href, { binary, maxAgeMs: cacheTtlMs });
    if (cached) {
      return { ...cached, fromCache: true, ok: true, url: url.href };
    }
  }

  const robots = await checkRobots(url.href, USER_AGENT, { timeoutMs });
  if (!robots.allowed) {
    throw new FetchBlockedError(url.href, `robots.txt disallows it (${robots.reason})`);
  }
  const effectiveDelay = robots.crawlDelay
    ? Math.max(minDelayMs, robots.crawlDelay * 1000)
    : minDelayMs;

  return enqueue(host, async () => {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await respectDelay(host, effectiveDelay);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        log.debug(`${method} ${url.href}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        const res = await fetch(url.href, {
          method,
          headers: {
            'user-agent': USER_AGENT,
            accept,
            'accept-language': 'en-IN,en;q=0.9,hi;q=0.8',
            ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            ...(cookie ? { cookie } : {}),
          },
          body: form ? new URLSearchParams(form).toString() : undefined,
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);
        lastHit.set(host, Date.now());

        // A redirect must not carry us off a government domain.
        assertAllowed(res.url || url.href);

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status}`);
          const backoff = effectiveDelay * Math.pow(2, attempt);
          log.warn(`  ${res.status} from ${host}, backing off ${Math.round(backoff / 1000)}s`);
          await sleep(backoff);
          continue;
        }

        const contentType = res.headers.get('content-type') || '';
        const fetchedAt = new Date().toISOString();

        if (!res.ok) {
          return { ok: false, status: res.status, url: res.url || url.href, body: binary ? Buffer.alloc(0) : '', contentType, fromCache: false, fetchedAt };
        }

        const body = binary
          ? Buffer.from(await res.arrayBuffer())
          : await res.text();

        const setCookie = res.headers.getSetCookie?.() ?? [];
        const result = { ok: true, status: res.status, url: res.url || url.href, body, contentType, fromCache: false, fetchedAt, setCookie };
        if (cacheable) await writeCache(url.href, result, { binary });
        return result;
      } catch (err) {
        clearTimeout(timer);
        lastHit.set(host, Date.now());
        lastError = err;
        if (err.name === 'DisallowedTargetError') throw err; // never retry a boundary violation
        if (attempt < MAX_ATTEMPTS) {
          const backoff = effectiveDelay * Math.pow(2, attempt);
          log.warn(`  ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
          await sleep(backoff);
        }
      }
    }

    // Keep the underlying cause code. Node reports a TLS chain problem as a
    // bare "fetch failed" with the real reason on err.cause, and flattening it
    // to the message lost the one detail that says whether a browser could get
    // past it — so a recoverable site looked identical to a dead one.
    const cause = lastError?.cause?.code ?? lastError?.code ?? null;
    const failure = new Error(
      `Failed after ${MAX_ATTEMPTS} attempts: ${url.href} — ${lastError?.message}`
      + (cause ? ` (${cause})` : '')
    );
    failure.cause = lastError?.cause ?? lastError;
    failure.code = cause;
    throw failure;
  });
}

export function httpStats() {
  return { hostsContacted: [...lastHit.keys()] };
}
