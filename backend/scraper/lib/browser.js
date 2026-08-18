/**
 * Shared headless browser, used as a fallback when plain HTTP cannot read a
 * government site.
 *
 * Two whole categories of site were being written off as unscrapeable, and a
 * browser reaches both:
 *
 *   Incomplete TLS chains. Several ministries serve a certificate without its
 *   intermediate. Node rejects that outright; Chromium fetches the missing
 *   certificate from the issuer named in the leaf, which is what every visitor's
 *   browser already does. tribal.nic.in, online-inspire.gov.in and
 *   scholarship.up.gov.in all return 200 this way after failing in Node.
 *
 *   Client-rendered pages. A React or Liferay portal serves an empty shell over
 *   HTTP; the schemes only exist after the scripts run.
 *
 * What this is NOT is a way around a refusal. A certificate that genuinely does
 * not cover its hostname is rejected here too — swd.kerala.gov.in fails in
 * Chromium exactly as it does in Node, and stays disabled. Nor does it disguise
 * anything: the browser sends the same SchemeConnectBot user-agent as the HTTP
 * client, and a site that answers 403 to that keeps answering 403.
 */

import { checkUrl } from './allowlist.js';
import { log } from './log.js';

export const USER_AGENT =
  'SchemeConnectBot/0.1 (+https://schemeconnect.com/bot; scholarship discovery for students; contact support@schemeconnect.com)';

const NAV_TIMEOUT_MS = 45000;
/** Same courtesy the HTTP client applies: one page at a time per host. */
const MIN_GAP_MS = 1500;

let browserPromise = null;
const hostQueues = new Map();

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({ args: ['--disable-dev-shm-usage'] });
    })();
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

/** True once a browser has actually been launched — used to skip teardown. */
export const browserWasUsed = () => browserPromise !== null;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function perHost(host, task) {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const result = await task();
    await pause(MIN_GAP_MS);
    return result;
  });
  hostQueues.set(host, next.catch(() => {}));
  return next;
}

/**
 * Renders one page and returns its HTML, or null.
 *
 * @param {string} url
 * @param {{waitForText?: RegExp, timeoutMs?: number}} options
 */
export async function renderPage(url, { waitForText = null, timeoutMs = NAV_TIMEOUT_MS } = {}) {
  const allowed = checkUrl(url);
  if (!allowed.ok) return { ok: false, error: `blocked: ${allowed.reason}` };

  const host = new URL(url).hostname;

  return perHost(host, async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block' });
    // Images and fonts cost the site bandwidth and tell us nothing.
    await context.route('**/*', (route) =>
      ['image', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue());

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const status = response?.status() ?? 0;

      if (status >= 400) {
        return { ok: false, status, error: `HTTP ${status}` };
      }

      // A client-rendered page reaches domcontentloaded while still empty, so
      // wait for something real rather than for the network to settle.
      try {
        await page.waitForFunction(
          (pattern) => {
            const text = document.body?.innerText ?? '';
            if (text.length < 400) return false;
            return pattern ? new RegExp(pattern, 'i').test(text) : true;
          },
          waitForText ? waitForText.source : null,
          { timeout: Math.min(timeoutMs, 20000) }
        );
      } catch {
        // Fall through: a genuinely short page is still worth returning.
      }

      const body = await page.content();
      return { ok: true, status, body, url: page.url(), fetchedAt: new Date().toISOString() };
    } catch (err) {
      const message = (err.message || '').split('\n')[0];
      log.debug(`    browser could not load ${url}: ${message}`);
      return { ok: false, error: message };
    } finally {
      await context.close();
    }
  });
}

/**
 * Whether a plain-HTTP failure is the kind a browser might get past.
 *
 * TLS chain problems and empty client-rendered shells are worth a retry. A 403,
 * a 404 or a host with no DNS record is not — the browser is not a way around a
 * decision the site made, and pretending otherwise just wastes a page load.
 */
export function worthRetryingInBrowser(error) {
  // Walk the cause chain: the retry wrapper reports "fetch failed" and hangs
  // the real reason off .cause.
  const text = [
    error?.message,
    error?.code,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(' ');
  return /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_SSL|LEGACY_RENEGOTIATION|DEPTH_ZERO_SELF_SIGNED/i
    .test(text);
}
