/**
 * Government-domain allowlist.
 *
 * This is the scraper's hard boundary: it may only ever fetch from Indian
 * government domains. Every outbound request in the scraper goes through
 * assertAllowed() first, and a non-government host throws rather than being
 * skipped — a silent skip would let a misconfigured source quietly widen the
 * crawl, which is exactly what this file exists to prevent.
 */

/** Suffixes that identify an Indian government host. */
const GOV_SUFFIXES = [
  '.gov.in',
  '.nic.in',
  '.ac.in.gov.in', // defensive: never matched in practice, kept explicit
];

/**
 * Hosts that end in a government suffix but are *not* scheme sources we want
 * to crawl (login walls, payment gateways, bulk file servers).
 */
const HOST_DENYLIST = new Set([
  'bharatkosh.gov.in',
  'pfms.nic.in',
  'digilocker.gov.in',
  'aadhaar.gov.in',
  'uidai.gov.in',
]);

/** Paths we never fetch even on an allowed host. */
const PATH_DENY_PATTERNS = [
  /\/login/i,
  /\/signin/i,
  /\/register/i,
  /\/apply(ing)?\//i,
  /\/otp/i,
  /\/payment/i,
  /\/admin/i,
];

export class DisallowedTargetError extends Error {
  constructor(url, reason) {
    super(`Blocked non-permitted scrape target: ${url} — ${reason}`);
    this.name = 'DisallowedTargetError';
    this.url = url;
    this.reason = reason;
  }
}

export function isGovernmentHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'gov.in' || host === 'nic.in') return true;
  return GOV_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Returns { ok: true } or { ok: false, reason } without throwing.
 * Use assertAllowed() on the request path; this is for reporting/filtering.
 */
export function checkUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a parseable URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `protocol ${url.protocol} is not http(s)` };
  }
  if (url.protocol === 'http:') {
    // Government sites all serve https; plain http suggests a spoofed host.
    return { ok: false, reason: 'plain http is not permitted, use https' };
  }
  if (!isGovernmentHost(url.hostname)) {
    return {
      ok: false,
      reason: `host "${url.hostname}" is not an Indian government domain (.gov.in / .nic.in)`,
    };
  }
  if (HOST_DENYLIST.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: `host "${url.hostname}" is on the scraper denylist` };
  }
  const deniedPath = PATH_DENY_PATTERNS.find((re) => re.test(url.pathname));
  if (deniedPath) {
    return { ok: false, reason: `path "${url.pathname}" matches a denied pattern` };
  }
  return { ok: true, url };
}

/** Throws DisallowedTargetError unless the URL is a permitted government target. */
export function assertAllowed(rawUrl) {
  const result = checkUrl(rawUrl);
  if (!result.ok) throw new DisallowedTargetError(rawUrl, result.reason);
  return result.url;
}

export const ALLOWLIST_DESCRIPTION =
  'https only, host must end in .gov.in or .nic.in, minus an explicit host/path denylist';
