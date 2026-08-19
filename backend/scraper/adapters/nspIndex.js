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
import { STATES } from '../lib/extract.js';
import { checkUrl } from '../lib/allowlist.js';
import { htmlToText } from '../lib/html.js';
import { extractAll } from '../lib/extract.js';
import { pdfToText, isPdfToTextAvailable } from '../lib/pdf.js';
import { toScheme, toListingScheme } from '../lib/normalize.js';
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

/**
 * The three form endpoints that hold the rest of the catalogue.
 *
 * The landing page shows a sample. The full directory is only reachable by
 * submitting its own filters, so there is no URL to crawl: the department and
 * domicile forms ARE the index. Posting them is how a visitor sees the list,
 * which is why it is worth doing — and it is where every state scheme lives.
 */
const FORMS = [
  { path: '/allschemesdepartment', field: 'ministryiddept', kind: 'central' },
  { path: '/allschemesdomicile', field: 'stateidschems', kind: 'state' },
];

/**
 * Reads the filter options the page itself offers.
 *
 * Hardcoding the ids would rot the moment NSP onboards a state — and it does,
 * every year. The page lists them, so we read them.
 *
 * @returns {{value: string, label: string, isState: boolean}[]}
 */
function formOptions(html) {
  const out = new Map();
  const re = /<option[^>]*value="(\d+)"[^>]*>([^<]{2,80})<\/option>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!label || /choose|select/i.test(label)) continue;
    out.set(m[1], { value: m[1], label, isState: /^(State of|UT of)\b/i.test(label) });
  }
  return [...out.values()];
}

/**
 * Turns NSP's own label into a state we actually recognise.
 *
 * Their spellings are not ours — "State of Chattisgarh" is missing an h, and
 * the Daman and Diu merger is written the long way round. A label we cannot
 * place returns null rather than a guess, because a scheme filed under the
 * wrong state is worse than one filed under none: it would be offered to
 * students who cannot apply for it.
 */
export function stateFromLabel(label) {
  const bare = String(label).replace(/^(State of|UT of)\s+/i, '').trim();

  // Compare on words, not on the raw string. NSP writes the merged UT as
  // "The Dadra Nagar Haveli and Daman and Diu" where we write "Dadra and
  // Nagar Haveli and Daman and Diu" — the same place, one "and" apart. Joining
  // the letters would also have to drop "and" from "Andaman", so the filler
  // words are dropped as whole tokens or not at all.
  const norm = (v) => String(v).toLowerCase().split(/[^a-z]+/i)
    .filter((w) => w && w !== 'and' && w !== 'the').join('');

  const target = norm(bare);
  const exact = STATES.find((s) => norm(s) === target);
  if (exact) return exact;

  // "Chattisgarh" for "Chhattisgarh": theirs is simply misspelt, and an h is
  // the only difference, so ignoring h alone settles it without loosening the
  // comparison enough to confuse two real states.
  const loose = STATES.find((s) => norm(s).replace(/h/g, '') === target.replace(/h/g, ''));
  return loose ?? null;
}

/** Submits one filter and returns the scheme blocks it answers with. */
async function postForm(baseUrl, form, option, cookie) {
  const url = new URL(form.path, baseUrl).href;
  const res = await govFetch(url, {
    method: 'POST',
    form: { [form.field]: option.value },
    cookie,
    useCache: false,
    minDelayMs: 1200,
  });
  if (!res.ok) return [];
  return splitBlocks(res.body).filter((b) => SCHEME_NAME.test(b.name));
}

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

  const indexBlocks = splitBlocks(res.body).filter((b) => SCHEME_NAME.test(b.name));

  /**
   * Walk the filters as well as the page.
   *
   * The landing page is a shop window — a few dozen schemes out of a directory
   * of several hundred. Every state scheme on NSP sits behind the domicile
   * filter and appears on no crawlable URL at all, which is why the catalogue
   * had one state in it for so long. One request per option, paced like any
   * other host, buys the rest.
   */
  const cookie = (res.setCookie ?? []).map((c) => c.split(';')[0]).join('; ') || null;
  const options = formOptions(res.body);
  const found = [{ blocks: indexBlocks, level: source.level ?? 'central', state: source.state ?? null }];

  for (const form of FORMS) {
    const wanted = options.filter((o) => o.isState === (form.kind === 'state'));
    for (const option of wanted) {
      let blocks;
      try {
        blocks = await postForm(res.url, form, option, cookie);
      } catch (err) {
        log.warn(`  ${option.label}: ${err.message}`);
        continue;
      }
      if (form.kind === 'state') {
        const state = stateFromLabel(option.label);
        if (!state) {
          // Better to skip than to file it under a state we invented.
          log.warn(`  no match for "${option.label}" in our state list — skipped`);
          continue;
        }
        found.push({ blocks, level: 'state', state });
        log.debug(`  ${state}: ${blocks.length} scheme(s)`);
      } else {
        found.push({ blocks, level: 'central', state: null });
        log.debug(`  ${option.label}: ${blocks.length} scheme(s)`);
      }
    }
  }

  const total = found.reduce((n, f) => n + f.blocks.length, 0);
  log.info(`  read ${options.length} filter(s) on NSP's own form — ${total} row(s) before dedupe`);

  // Each block becomes a scheme in its own right. The href is kept so the
  // guideline PDF can be linked, but the row is what carries the dates.
  const seen = new Set();
  const candidates = [];
  for (const group of found) {
   for (const block of group.blocks) {
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
      level: group.level,
      state: group.state,
      sourceId: source.id,
      // Everything this adapter needs is already in hand; extract() does no
      // further fetching, which is why the whole index costs one request.
      block,
      applyUrl,
      fetchedAt: res.fetchedAt,
    });
   }
  }

  log.info(`  ${candidates.length} distinct scheme row(s), with application windows`);
  return {
    candidates: candidates.slice(0, source.maxLinks ?? 60),
    listings: [],
    pageTitle: 'NSP — All Scholarships',
    fetchedAt: res.fetchedAt,
  };
}

let pdftotext = null;

/**
 * Reads the guideline PDF the directory row links to.
 *
 * The row itself is a name, an owner and a set of dates. The eligibility — the
 * income ceiling, the castes, the marks, the course levels — is in the PDF
 * beside it, which is the document the scheme is actually administered from.
 * Without it a third of NSP's schemes could only be listed, not matched, and
 * a scheme a student cannot be matched to is one they will not be shown.
 *
 * A failure here is not an error. The row already stands on its own, so a PDF
 * that is missing, scanned, or slow simply leaves the scheme where it was.
 */
async function criteriaFromGuidelines(url) {
  if (!url || !/\.pdf($|\?)/i.test(url)) return null;
  pdftotext ??= await isPdfToTextAvailable();
  if (!pdftotext) return null;

  try {
    const res = await govFetch(url, { binary: true, accept: 'application/pdf,*/*' });
    if (!res.ok) return null;
    const { text, error } = await pdfToText(res.body);
    // Under a few hundred characters it is a scan, and running the extractors
    // over the handful of words OCR-free parsing found would invent criteria.
    if (error || !text || text.length < 400) return null;
    return { text, extracted: extractAll(text) };
  } catch {
    return null;
  }
}

export async function extract(candidate) {
  const block = candidate.block;
  if (!block) return { scheme: null, error: 'no index row for this candidate' };

  const opensAt = toIsoDate(/Open\s*from\s*:?\s*([\d-]+)/i.exec(block.body)?.[1]);
  const closesAt = toIsoDate(/Open\s*till\s*:?\s*([\d-]+)/i.exec(block.body)?.[1]);

  let text = `${block.name}. ${block.body}`;
  let extracted = extractAll(text);

  /**
   * The row's dates outrank the PDF's.
   *
   * A guideline document is written once and often names the year it was
   * drafted; the portal's own window is the operational date, updated every
   * season. So the PDF supplies eligibility and the row keeps the deadline.
   */
  const guidelines = await criteriaFromGuidelines(candidate.applyUrl);
  if (guidelines) {
    text = `${block.name}. ${guidelines.text}`;
    extracted = guidelines.extracted;
    log.debug(`    read guidelines for ${block.name.slice(0, 48)}`);
  }

  // The window stated on the index beats anything a heuristic reads out of
  // prose: it is the portal's own operational date, not a sentence about one.
  if (closesAt) {
    extracted.deadline = closesAt;
    extracted.criteriaEvidence = [
      ...(extracted.criteriaEvidence ?? []).filter((e) => e.field !== 'deadline'),
      { field: 'deadline', text: `National Scholarship Portal states this scheme is open till ${closesAt}.` },
    ];
  }

  /**
   * A directory row is not a scheme page.
   *
   * NSP states a name, an owner, a state and an application window — but the
   * eligibility lives in a guideline PDF behind it, so there is rarely enough
   * text here to read a criterion from. Held to the standard for a full record
   * that fails on length, and 137 of 160 schemes were thrown away: every state
   * scheme NSP has, with its real deadline, discarded for not being something
   * it never claimed to be.
   *
   * So a row with criteria becomes a full record, and one without becomes a
   * listing — the tier that already exists for exactly this, a scheme we can
   * name and link but not match on. The window comes with it either way.
   */
  const eligible = extracted.eligibility ?? extracted;
  const hasCriteria = Boolean(
    eligible.maxFamilyIncome
    || eligible.categories?.length
    || eligible.gender?.length
    || eligible.courseLevels?.length
    || eligible.minMarksPercent
    || eligible.disabilityRequired
  );

  if (!hasCriteria) {
    const listing = toListingScheme({
      name: block.name,
      summary: `Listed on the National Scholarship Portal${block.ministry ? `, run by ${block.ministry}` : ''}.`,
      officialUrl: candidate.applyUrl,
      sourceUrl: candidate.url,
      adapter: id,
      level: candidate.level,
      state: candidate.state,
      ministry: block.ministry,
      deadline: closesAt ?? null,
      criteriaEvidence: closesAt ? extracted.criteriaEvidence ?? [] : [],
      fetchedAt: candidate.fetchedAt,
    });
    if (opensAt) listing.opensAt = opensAt;
    return { scheme: listing, error: null };
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
    // A directory row, not a page of prose — see validateScheme.
    structured: true,
    fetchedAt: candidate.fetchedAt,
  });

  if (opensAt) scheme.opensAt = opensAt;
  return { scheme, error: null };
}
