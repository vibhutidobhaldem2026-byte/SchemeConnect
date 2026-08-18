/**
 * National Scholarship Portal — the "All Scholarships" index.
 *
 * This page is the only source found anywhere that states when you can actually
 * apply. Every other site describes a scheme in the abstract — who it is for,
 * what it pays — and never says the window is open until 31 October. The
 * catalogue had a deadline field that no scheme ever filled, so the deadline
 * ranking the PRD asks for did nothing and a student could be sent to a scheme
 * that closed months ago.
 *
 * Unlike the rest of the crawl this reads the INDEX rather than following it.
 * The dates live on this page, one row per scheme; the detail behind each link
 * is a guideline PDF that repeats the eligibility but not the window. So the
 * row is the record, and the PDF is a bonus we fetch through the usual path.
 */

import { govFetch } from '../lib/httpClient.js';
import { checkUrl } from '../lib/allowlist.js';
import { htmlToText } from '../lib/html.js';
import { extractAll } from '../lib/extract.js';
import { toScheme } from '../lib/normalize.js';
import { log } from '../lib/log.js';

export const id = 'nsp-index';

/** dd-mm-yyyy, as NSP writes it, to the ISO date the catalogue stores. */
function toIsoDate(text) {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(text ?? ''));
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (Number.isNaN(date.getTime())) return null;
  // Guard against a transposed row turning 01-13-2026 into a silent rollover.
  if (date.getUTCMonth() !== Number(mm) - 1) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Splits the index into one block per scheme.
 *
 * Each scheme is an <h6> with its ministry logo and a run of date pills after
 * it — no table, and the class names are Bootstrap utilities that say nothing
 * about content. The heading is therefore the only stable boundary: a block
 * runs from one <h6> to the next.
 */
function splitBlocks(html) {
  const blocks = [];
  // Comments first. Each scheme is followed by a commented-out "<h6>by
  // Ministry…</h6>", and a lookahead for the next heading stops dead inside it —
  // every block truncated to 90 characters and lost its dates.
  const source = String(html).replace(/<!--[\s\S]*?-->/g, ' ');
  const re = /<h6[^>]*>([\s\S]{6,220}?)<\/h6>([\s\S]*?)(?=<h6[^>]*>|$)/gi;
  let m;
  while ((m = re.exec(source))) {
    const name = htmlToText(m[1]).replace(/\s+/g, ' ').trim();
    const raw = m[2];
    const body = htmlToText(raw).replace(/\s+/g, ' ').trim();
    if (name.length < 10) continue;

    // The owning ministry is named only in its logo's filename.
    const ministry = /MinistryImages\/([^"'?]+)\.(?:png|jpe?g|svg)/i.exec(raw)?.[1]
      ?.replace(/[-_]+/g, ' ').trim() ?? null;

    // The first government link after the heading is the scheme's own page.
    const href = /<a\b[^>]*href="([^"#]+)"/i.exec(raw)?.[1] ?? null;

    blocks.push({ name, body, ministry, href });
  }
  return blocks;
}

const SCHEME_NAME = /scholarship|fellowship|scheme|stipend|yojana|vriti/i;

export async function discover(source) {
  const check = checkUrl(source.url);
  if (!check.ok) return { candidates: [], error: `source blocked: ${check.reason}` };

  let res;
  try {
    res = await govFetch(source.url);
  } catch (err) {
    return { candidates: [], error: err.message };
  }
  if (!res.ok) return { candidates: [], error: `HTTP ${res.status}` };

  const blocks = splitBlocks(res.body).filter((b) => SCHEME_NAME.test(b.name));

  // Each block becomes a scheme in its own right. The href is kept so the
  // guideline PDF can be linked, but the row is what carries the dates.
  const seen = new Set();
  const candidates = [];
  for (const block of blocks) {
    const key = block.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let applyUrl = source.url;
    if (block.href) {
      try {
        const resolved = new URL(block.href, res.url).href;
        if (checkUrl(resolved).ok) applyUrl = resolved;
      } catch { /* keep the index as the link */ }
    }

    candidates.push({
      url: source.url,
      title: block.name,
      isPdf: false,
      level: source.level ?? 'central',
      state: source.state ?? null,
      sourceId: source.id,
      // Everything this adapter needs is already in hand; extract() does no
      // further fetching, which is why the whole index costs one request.
      block,
      applyUrl,
      fetchedAt: res.fetchedAt,
    });
  }

  log.info(`  ${candidates.length} scheme row(s) on the index, with application windows`);
  return {
    candidates: candidates.slice(0, source.maxLinks ?? 60),
    listings: [],
    pageTitle: 'NSP — All Scholarships',
    fetchedAt: res.fetchedAt,
  };
}

export async function extract(candidate) {
  const block = candidate.block;
  if (!block) return { scheme: null, error: 'no index row for this candidate' };

  const opensAt = toIsoDate(/Open\s*from\s*:?\s*([\d-]+)/i.exec(block.body)?.[1]);
  const closesAt = toIsoDate(/Open\s*till\s*:?\s*([\d-]+)/i.exec(block.body)?.[1]);

  const text = `${block.name}. ${block.body}`;
  const extracted = extractAll(text);

  // The window stated on the index beats anything a heuristic reads out of
  // prose: it is the portal's own operational date, not a sentence about one.
  if (closesAt) {
    extracted.deadline = closesAt;
    extracted.criteriaEvidence = [
      ...(extracted.criteriaEvidence ?? []).filter((e) => e.field !== 'deadline'),
      { field: 'deadline', text: `National Scholarship Portal states this scheme is open till ${closesAt}.` },
    ];
  }

  const scheme = toScheme({
    name: block.name,
    summary: block.body.slice(0, 280) || null,
    sourceUrl: candidate.url,
    officialUrl: candidate.applyUrl,
    adapter: id,
    docType: 'html',
    rawText: text,
    extracted,
    level: candidate.level,
    state: candidate.state,
    ministry: block.ministry,
    fetchedAt: candidate.fetchedAt,
  });

  if (opensAt) scheme.opensAt = opensAt;
  return { scheme, error: null };
}
