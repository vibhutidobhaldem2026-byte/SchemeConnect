/**
 * DBT Bharat — the Direct Benefit Transfer mission's central scheme register.
 *
 * Worth having for one reason: it is a register, not a website. Every other
 * source we crawl is one department describing its own programmes, so covering
 * the country means finding and crawling every department. This page lists 320
 * schemes from 56 ministries and, beside each, links the page the owning
 * department actually publishes it on. That makes it a seed list — it points
 * at hosts we would otherwise never have thought to look at, including several
 * research-council domains that no scheme directory mentions.
 *
 * We link students to the department's page, never to DBT Bharat's own copy.
 * Its internal links rot — a batch of them is why a quarter of the catalogue's
 * links were dead — whereas the department page is the one the scheme is
 * administered from.
 *
 * A good share of the links leave government domains entirely (icar.org.in,
 * ugc.ac.in, a bank's scholarship portal). Those are dropped rather than
 * followed: the allowlist is the guarantee that we only ever send a student to
 * an official page, and it is not worth weakening for extra rows.
 */

import { govFetch } from '../lib/httpClient.js';
import { checkUrl } from '../lib/allowlist.js';
import { htmlToText } from '../lib/html.js';
import { looksEducational } from '../lib/normalize.js';
import { log } from '../lib/log.js';
import govHtml from './govHtml.js';

export const id = 'dbt-bharat';

/**
 * "Department of Agricultural Research and Education : 14 Schemes"
 *
 * The count and the word Schemes sit on their own lines with a paragraph of
 * indentation between them, so the heading is far longer in the source than it
 * looks on the page — a tight length bound matched none of the 56 of them.
 */
const HEADING = /<div[^>]*class=['"][^'"]*pageSubHeading[^'"]*['"][^>]*>([\s\S]{4,600}?)<\/div>/gi;
const LINK = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*title=["']Scheme Page URL["'][^>]*>([\s\S]{3,200}?)<\/a>/gi;

/**
 * Splits the register into ministry sections.
 *
 * The ministry is only stated in a heading above its list, so a link on its own
 * carries no attribution. Reading the page as a sequence of sections keeps each
 * scheme with the department that runs it, which is what the catalogue shows
 * beside the scheme name.
 */
function sections(html) {
  const marks = [];
  let m;
  HEADING.lastIndex = 0;
  while ((m = HEADING.exec(html))) {
    const label = htmlToText(m[1]).replace(/\s+/g, ' ').replace(/\s*:\s*\d+\s*Schemes?\s*$/i, '').trim();
    marks.push({ label, start: m.index + m[0].length });
  }
  return marks.map((mark, i) => ({
    ministry: mark.label,
    body: html.slice(mark.start, marks[i + 1]?.start ?? html.length),
  }));
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

  const candidates = [];
  const seen = new Set();
  let offsite = 0;
  let notEducational = 0;

  for (const section of sections(res.body)) {
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(section.body))) {
      const name = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
      if (name.length < 6) continue;

      // The register is every DBT scheme there is — pensions, crop insurance,
      // fertiliser subsidy. Ours is a scholarship catalogue, so the gate that
      // keeps AVYAY out of a student's results applies here too.
      if (!looksEducational({ name, ministry: section.ministry })) { notEducational++; continue; }

      let url;
      try {
        url = new URL(m[1], res.url).href;
      } catch { continue; }
      if (!checkUrl(url).ok) { offsite++; continue; }

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        url,
        title: name,
        isPdf: /\.pdf($|\?)/i.test(url),
        level: source.level ?? 'central',
        state: source.state ?? null,
        sourceId: source.id,
        ministry: section.ministry || null,
        fetchedAt: res.fetchedAt,
      });
    }
  }

  log.info(`  ${candidates.length} education scheme(s) on the register`);
  log.debug(`  skipped ${notEducational} non-education and ${offsite} off government domains`);

  return {
    candidates: candidates.slice(0, source.maxLinks ?? 120),
    listings: [],
    pageTitle: 'DBT Bharat — central scheme register',
    fetchedAt: res.fetchedAt,
  };
}

/**
 * The register names a scheme and points at it; it describes nothing. The
 * eligibility has to come from the department's own page, which is an ordinary
 * government HTML page — so the generic adapter reads it, and this one's job
 * ends at having found it.
 */
export async function extract(candidate) {
  const result = await govHtml.extract(candidate);
  if (result.scheme) {
    result.scheme.source.adapter = id;
    if (candidate.ministry && !result.scheme.ministry) result.scheme.ministry = candidate.ministry;
  }
  return result;
}

export default { id, discover, extract };
