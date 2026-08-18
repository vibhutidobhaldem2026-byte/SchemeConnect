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

export const id = 'gov-html';

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

  let res;
  try {
    res = await govFetch(source.url);
  } catch (err) {
    return { candidates: [], error: err.message };
  }
  if (!res.ok) {
    return { candidates: [], error: `HTTP ${res.status}` };
  }

  const listings = extractListings(res.body, res.url, source, res.fetchedAt);

  const links = getLinks(res.body, res.url);
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
    res = await govFetch(candidate.url);
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

  const extracted = extractAll(text);
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
