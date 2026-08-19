/**
 * Generic government HTML adapter.
 *
 * Two phases:
 *   discover(source)  — pull candidate scheme links off a listing page
 *   extract(candidate) — fetch one page and turn it into a Scheme record
 *
 * Government CMS markup varies wildly between ministries, so extraction leans
 * on labelled sections ("Eligibility", "Documents Required") first and falls
 * back to whole-page prose. PDF links found during discovery are handed to the
 * PDF adapter rather than parsed here.
 */

import { govFetch } from '../lib/httpClient.js';
import { checkUrl } from '../lib/allowlist.js';
import {
  getLinks, getTitle, getHeadings, htmlToText, sectionAfterHeading, getMetaDescription,
  getTables, getListItems,
} from '../lib/html.js';
import { extractAll } from '../lib/extract.js';
import { toScheme, toListingScheme } from '../lib/normalize.js';
import { SCHEME_LINK_HINTS, SCHEME_LINK_EXCLUDE } from '../../config/sources.js';
import { log } from '../lib/log.js';
import { renderPage, worthRetryingInBrowser } from '../lib/browser.js';

export const id = 'gov-html';

/**
 * Fetches a page, falling back to a real browser when plain HTTP cannot.
 *
 * Several ministries serve a certificate without its intermediate, which Node
 * refuses and Chromium resolves by fetching the missing certificate — the same
 * thing every visitor's browser does. Others render their scheme list with
 * JavaScript, so the HTML arrives empty. Both were being written off as
 * unscrapeable; neither needs to be.
 *
 * A 403, a 404 or a dead host is NOT retried. The browser is not a way around a
 * refusal, and a second load would only waste the site's bandwidth.
 */
async function fetchPage(url, { forceBrowser = false } = {}) {
  // A source marked browser-only skips the HTTP attempt entirely. For a portal
  // that renders its scheme list with JavaScript, the plain fetch can only ever
  // return an empty shell — trying it first costs the site a request and us a
  // round trip to learn what the config already knows.
  if (forceBrowser) {
    const rendered = await renderPage(url);
    if (rendered.ok) return { res: rendered, via: 'browser' };
    throw new Error(rendered.error || 'browser could not load the page');
  }

  let httpError = null;
  try {
    const res = await govFetch(url);
    // A 200 that carries almost no text is a client-rendered shell.
    if (res.ok && htmlToText(res.body).trim().length >= 400) return { res, via: 'http' };
    if (res.ok) {
      log.debug(`    ${url} returned an empty shell — trying a browser`);
      const rendered = await renderPage(url);
      if (rendered.ok) return { res: rendered, via: 'browser' };
      return { res, via: 'http' }; // keep the thin original rather than nothing
    }
    httpError = new Error(`HTTP ${res.status}`);
    httpError.status = res.status;
  } catch (err) {
    httpError = err;
  }

  if (worthRetryingInBrowser(httpError)) {
    log.debug(`    ${url} failed TLS in Node — trying a browser`);
    const rendered = await renderPage(url);
    if (rendered.ok) {
      log.info(`    recovered ${new URL(url).hostname} with a browser (TLS chain incomplete for Node)`);
      return { res: rendered, via: 'browser' };
    }
  }
  throw httpError;
}

function looksLikeScheme(link) {
  if (SCHEME_LINK_EXCLUDE.some((re) => re.test(link.href))) return false;
  if (!link.text || link.text.length < 6 || link.text.length > 160) return false;
  const haystack = `${link.text} ${link.href}`;
  return SCHEME_LINK_HINTS.some((re) => re.test(haystack));
}

const SCHEME_NAME_RE = /scholarship|scheme|yojana|fellowship|stipend|chhatra|vriti/i;

/**
 * Pulls scheme names out of a government listing page.
 *
 * Two shapes are common:
 *  - a table with a "Scheme Name" column (and often a "Website URL" column)
 *  - a flat bulleted list of scheme names
 *
 * These give an authoritative name and, where present, the official URL —
 * enough for a browsable catalog entry even when we can't reach the detail page.
 */
function extractListings(html, baseUrl, source, fetchedAt) {
  const out = [];
  const seen = new Set();

  const push = (name, officialUrl) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 10 || clean.length > 180) return;
    if (!SCHEME_NAME_RE.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    // We send students to this link. It has to be a government page, by the
    // same rule the crawler applies to itself — a listing may well point at a
    // private aggregator, and that is not something we hand a student.
    const official = officialUrl && checkUrl(officialUrl).ok ? officialUrl : null;
    out.push(
      toListingScheme({
        name: clean,
        officialUrl: official,
        sourceUrl: baseUrl,
        adapter: id,
        level: source.level,
        state: source.state || null,
        ministry: source.label,
        summary: `Listed by ${source.label}.`,
        fetchedAt,
      })
    );
  };

  // --- tables -------------------------------------------------------------
  for (const rows of getTables(html)) {
    if (rows.length < 2) continue;
    const header = rows[0].map((c) => c.toLowerCase());
    const nameCol = header.findIndex((c) => /scheme|name of/.test(c));
    const urlCol = header.findIndex((c) => /website|url|link|portal/.test(c));
    if (nameCol === -1) continue;

    for (const row of rows.slice(1)) {
      const name = row[nameCol];
      const url = urlCol >= 0 ? row[urlCol] : null;
      push(name, url && /^https?:\/\//i.test(url) ? url : null);
    }
  }

  // --- cards --------------------------------------------------------------
  /**
   * Newer government sites lay a listing out as cards, not a table or a list.
   *
   * Nagaland's scholarship portal is one: each scheme is an <article> with its
   * name in a heading, and its department, level, funding agency and nodal
   * officer as text underneath — richer than most state listings, and
   * completely invisible to us, because none of it is a link and so there was
   * nothing to follow. Reading the heading is what a visitor does.
   *
   * Scoped to <article> deliberately. Sweeping every h2 on a page would drag
   * in section titles and sidebar furniture, which is how a navigation label
   * ends up in the catalogue looking like a scheme.
   *
   * The length bound is generous because a card is bigger than it looks: with
   * icons and utility classes, Nagaland's run to six thousand characters, and
   * a tighter limit silently matched only the shortest seven of twenty-four.
   */
  for (const [, block] of String(html).matchAll(/<article\b[^>]*>([\s\S]{40,24000}?)<\/article>/gi)) {
    const heading = /<h[2-4][^>]*>([\s\S]{6,200}?)<\/h[2-4]>/i.exec(block);
    if (!heading) continue;
    const href = /<a\b[^>]*href="([^"#]+)"/i.exec(block)?.[1];
    let resolved = null;
    try {
      if (href) resolved = new URL(href, baseUrl).href;
    } catch { /* a malformed href is no link at all */ }
    push(htmlToText(heading[1]), resolved);
  }

  // --- bulleted lists -----------------------------------------------------
  // The link on the item is the scheme's own page or guideline PDF. Without it
  // the entry pointed at whatever index page it was found on, so "Continue to
  // official application" led to a list rather than the scheme.
  for (const item of getListItems(html, baseUrl)) {
    push(item.text, item.href);
  }

  return out;
}

/** Finds candidate scheme pages/PDFs linked from a listing page. */
export async function discover(source) {
  const check = checkUrl(source.url);
  if (!check.ok) {
    return { candidates: [], error: `source blocked: ${check.reason}` };
  }

  /**
   * Some listings run to several pages.
   *
   * Meghalaya publishes 119 schemes twenty at a time; reading only the first
   * page would take a sixth of the state and quietly call it the whole thing.
   * A source declares its own page URLs because the shape differs — a query
   * parameter on Drupal, a path segment on WordPress — and there is no reliable
   * way to infer which from the first page.
   */
  const urls = [source.url];
  if (source.paginate) {
    const { template, from = 2, to = 5 } = source.paginate;
    for (let n = from; n <= to; n++) urls.push(template.replace('{n}', String(n)));
  }

  let res;
  const listings = [];
  const links = [];
  const seenUrl = new Set();

  for (const url of urls) {
    let page;
    try {
      ({ res: page } = await fetchPage(url, { forceBrowser: source.browser === true }));
    } catch (err) {
      // The first page failing is a broken source; a later one failing just
      // ends the pagination, which is what a missing page 7 looks like.
      if (url === source.url) return { candidates: [], error: err.message };
      break;
    }
    if (!page.ok) {
      if (url === source.url) return { candidates: [], error: `HTTP ${page.status}` };
      break;
    }
    res ??= page;

    listings.push(...extractListings(page.body, page.url, source, page.fetchedAt));

    const fresh = getLinks(page.body, page.url).filter((l) => !seenUrl.has(l.href));
    for (const l of fresh) seenUrl.add(l.href);
    links.push(...fresh);

    /**
     * Stop when a page adds nothing.
     *
     * Sikkim ignores the page parameter and serves the same ten schemes for
     * every value of it. Without this we would ask for five identical pages
     * and think we were being thorough.
     */
    if (url !== source.url && fresh.length === 0) break;
  }

  const candidates = [];
  const seen = new Set();

  for (const link of links) {
    if (!checkUrl(link.href).ok) continue; // stays on government domains
    if (!looksLikeScheme(link)) continue;
    if (seen.has(link.href)) continue;
    seen.add(link.href);

    candidates.push({
      url: link.href,
      title: link.text,
      isPdf: /\.pdf(?:$|\?)/i.test(link.href),
      level: source.level,
      state: source.state || null,
      sourceId: source.id,
      // A portal that needs a browser for its index needs one for its pages.
      browser: source.browser === true,
    });
  }

  /**
   * Order candidates by how likely they are to carry real eligibility text:
   * a guideline PDF beats a scheme detail page, which beats a generic link.
   * With a per-source cap this decides what actually gets fetched.
   */
  const priority = (c) => {
    let score = 0;
    if (c.isPdf) score += 4;
    if (/guideline|circular|notification/i.test(`${c.title} ${c.url}`)) score += 3;
    if (/eligib|criteria/i.test(`${c.title} ${c.url}`)) score += 3;
    if (/scholarship|fellowship|yojana|stipend/i.test(c.title)) score += 2;
    if (/scheme/i.test(c.title)) score += 1;
    return score;
  };
  candidates.sort((a, b) => priority(b) - priority(a));
  candidates.splice(source.maxLinks || 25);

  return { candidates, listings, pageTitle: getTitle(res.body), fetchedAt: res.fetchedAt };
}

/** Pulls the labelled sections a scheme page usually carries. */
function collectSections(html) {
  const parts = [];
  const wanted = [
    /eligib/i,
    /who\s+can\s+apply/i,
    /criteria/i,
    /benefit|amount|quantum|rate\s+of\s+scholarship/i,
    /document/i,
    /last\s+date|important\s+date|deadline/i,
    /objective|about|overview|introduction/i,
  ];
  for (const re of wanted) {
    const body = sectionAfterHeading(html, re);
    if (body) parts.push(body);
  }
  return parts.join('\n\n');
}

/** Fetches one candidate page and builds a Scheme record. */
export async function extract(candidate) {
  let res;
  try {
    ({ res } = await fetchPage(candidate.url, { forceBrowser: candidate.browser === true }));
  } catch (err) {
    return { scheme: null, error: err.message };
  }
  if (!res.ok) return { scheme: null, error: `HTTP ${res.status}` };

  const contentType = (res.contentType || '').toLowerCase();
  if (contentType.includes('pdf')) {
    return { scheme: null, error: 'served a PDF — routed to the PDF adapter', retryAsPdf: true };
  }

  const sections = collectSections(res.body);
  const fullText = htmlToText(res.body);
  // Prefer labelled sections; fall back to page prose when the page is unstructured.
  const text = sections.length > 300 ? `${sections}\n\n${fullText}` : fullText;

  if (text.length < 400) {
    return { scheme: null, error: `page text too short (${text.length} chars)` };
  }

  const headings = getHeadings(res.body);
  const name = candidate.title?.length > 10
    ? candidate.title
    : headings.find((h) => h.level <= 2 && h.text.length > 10)?.text || getTitle(res.body);

  const extracted = extractAll(text, { name: candidate.title || getTitle(res.body) });
  const summary = getMetaDescription(res.body)
    || extracted.evidence.find((e) => e.field === 'benefit')?.text
    || fullText.slice(0, 300);

  const scheme = toScheme({
    name,
    summary,
    sourceUrl: res.url,
    adapter: id,
    docType: 'html',
    rawText: text,
    extracted,
    level: candidate.level,
    state: candidate.state,
    fetchedAt: res.fetchedAt,
  });

  return { scheme, error: null };
}

/** NSP is the same shape as any other government site; only the label differs. */
export const nspAdapter = {
  id: 'nsp-html',
  discover: (source) => discover({ ...source }),
  extract: (candidate) => extract(candidate).then((r) => {
    if (r.scheme) r.scheme.source.adapter = 'nsp-html';
    return r;
  }),
};

export default { id, discover, extract };
