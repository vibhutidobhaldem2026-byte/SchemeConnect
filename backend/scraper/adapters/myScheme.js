/**
 * myScheme adapter — the Government of India's own scheme directory.
 *
 * Why this source, and why a browser.
 *
 * The ministry sites we were crawling publish a scheme once and then let the
 * page rot: of 123 links harvested that way, 17 were confirmed reachable, and
 * one ministry host had lost its DNS record entirely. Nothing a crawler does
 * can fix a page that no longer exists — the fix is to read a directory somebody
 * maintains. myscheme.gov.in is that directory, and it states eligibility as
 * discrete sentences rather than burying it in a circular.
 *
 * It renders client-side, so plain HTML fetching returns an empty shell. This
 * adapter drives a real browser instead. Two things that is NOT:
 *
 *   - It is not a robots.txt bypass. myscheme.gov.in publishes
 *     "User-agent: * / Allow: /" and disallows only /404. Rendering a page the
 *     way any visitor's browser does is squarely inside what that permits.
 *   - It is not user-agent spoofing. The browser identifies itself as
 *     SchemeConnectBot with a contact URL, exactly as the plain-HTTP crawler
 *     does. If a site refuses that, we take the refusal.
 *
 * The site also exposes a JSON API which rejects anonymous callers with a 403
 * unless you replay the key embedded in its own frontend bundle. We do not use
 * it. The 403 is a decision the operator made, and a key issued to their web app
 * is not a key issued to us — rendering the pages they invite crawlers to read
 * gets the same data without touching it.
 */

import { checkUrl } from '../lib/allowlist.js';
import { STATES } from '../lib/extract.js';
import { extractAll } from '../lib/extract.js';
import { toScheme } from '../lib/normalize.js';
import { log } from '../lib/log.js';

export const id = 'myscheme';

const ORIGIN = 'https://www.myscheme.gov.in';
const USER_AGENT =
  'SchemeConnectBot/0.1 (+https://schemeconnect.com/bot; scholarship discovery for students; contact support@schemeconnect.com)';

/** Same courtesy as the HTTP crawler: one page at a time, with a gap. */
const MIN_GAP_MS = 1500;
const NAV_TIMEOUT_MS = 45000;

/**
 * The site's own categories, which beat guessing at words. Education first;
 * skills and employment carries training and apprenticeship schemes, and women
 * and child carries girl-child scholarships filed nowhere else.
 */
const CATEGORY_FILTERS = [
  'Education & Learning',
  'Skills & Employment',
  'Women and Child',
  'Social welfare & Empowerment',
];

/** Terms that surface schemes a student could actually use. */
const DISCOVERY_QUERIES = [
  'scholarship', 'fellowship', 'stipend', 'education',
  'student', 'pre-matric', 'post-matric', 'merit',
  'girl child', 'minority scholarship', 'sc scholarship', 'st scholarship',
  'obc scholarship', 'disability education', 'research', 'tuition fee',
  'hostel', 'coaching', 'higher education', 'school',
];

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({ args: ['--disable-dev-shm-usage'] });
    })();
  }
  return browserPromise;
}

export async function close() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

async function withPage(fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    // Images and fonts are bandwidth we make somebody else pay for and never read.
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    return ['image', 'font', 'media'].includes(type) ? route.abort() : route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ discovery ----

/**
 * Collects scheme slugs by running the site's own search.
 *
 * The listing is paginated and rendered, so we read the links off each page and
 * click through. Several queries are used because one keyword never surfaces
 * the whole of what a student might qualify for.
 */
export async function discover(source) {
  const check = checkUrl(ORIGIN);
  if (!check.ok) return { candidates: [], error: `source blocked: ${check.reason}` };

  const maxLinks = source.maxLinks ?? 300;
  const slugs = new Set();

  const readSlugs = async (page) => {
    const hrefs = await page.$$eval('a[href*="/schemes/"]', (as) =>
      as.map((a) => a.getAttribute('href')).filter(Boolean));
    let added = 0;
    for (const href of hrefs) {
      const slug = href.split('/schemes/')[1]?.split(/[?#/]/)[0];
      if (slug && !slugs.has(slug)) { slugs.add(slug); added++; }
    }
    return added;
  };

  /** Results load on scroll; keep going until a pass adds nothing new. */
  const exhaust = async (page, label) => {
    await pause(2500);
    await readSlugs(page);
    for (let step = 0; step < 40 && slugs.size < maxLinks; step++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pause(1600);
      if ((await readSlugs(page)) === 0) break;
    }
    log.info(`    ${label} — ${slugs.size} scheme(s) so far`);
  };

  try {
    await withPage(async (page) => {
      /**
       * Use the site's own category filter rather than guessing keywords.
       *
       * myScheme carries 4,772 schemes across fifteen categories, and searching
       * for words like "scholarship" only ever surfaces the ones that happen to
       * say so. "Education & Learning" is the question we actually mean, and
       * "Skills & Employment" carries the training and apprenticeship schemes a
       * student can also use.
       */
      for (const category of CATEGORY_FILTERS) {
        if (slugs.size >= maxLinks) break;

        await page.goto(`${ORIGIN}/search`, { waitUntil: 'networkidle' });
        await pause(2200);

        // Click the checkbox that belongs to this category, found by walking
        // up from its label text. Clicking the text alone hit whichever element
        // happened to match first and toggled nothing.
        const applied = await page.evaluate((name) => {
          const wanted = name.toLowerCase().slice(0, 18);
          for (const box of document.querySelectorAll('input[type=checkbox]')) {
            const label =
              box.closest('label')?.innerText
              || box.parentElement?.innerText
              || box.getAttribute('aria-label')
              || '';
            if (label.toLowerCase().includes(wanted)) {
              if (!box.checked) box.click();
              return true;
            }
          }
          return false;
        }, category);

        if (!applied) {
          log.debug(`      no filter control found for "${category}"`);
          continue;
        }

        await exhaust(page, category);
        await pause(MIN_GAP_MS);
      }

      // Keyword passes still run, because the categories are assigned by the
      // site and a scholarship filed under "Social Welfare" would otherwise be
      // invisible to us.
      for (const query of DISCOVERY_QUERIES) {
        if (slugs.size >= maxLinks) break;
        await page.goto(`${ORIGIN}/search`, { waitUntil: 'networkidle' });
        await pause(1500);
        try {
          const box = page.getByPlaceholder('Search', { exact: false }).first();
          await box.fill(query, { timeout: 8000 });
          await box.press('Enter');
        } catch { continue; }
        await exhaust(page, `"${query}"`);
        await pause(MIN_GAP_MS);
      }
    });
  } catch (err) {
    /**
     * Keep what we already have.
     *
     * A dropped connection late in discovery used to throw away every slug
     * found before it — fifty schemes discarded because the fifty-first request
     * failed. Whatever was collected is still valid; the run simply covered
     * less ground than intended.
     */
    if (slugs.size === 0) {
      return { candidates: [], error: `browser discovery failed: ${err.message}` };
    }
    log.warn(`  discovery stopped early (${err.message.split('\n')[0].slice(0, 60)})`);
    log.warn(`  keeping the ${slugs.size} scheme(s) found before it failed.`);
  }

  const candidates = [...slugs].slice(0, maxLinks).map((slug) => ({
    url: `${ORIGIN}/schemes/${slug}`,
    title: slug,
    isPdf: false,
    level: source.level ?? 'central',
    state: source.state ?? null,
    sourceId: source.id,
  }));

  log.info(`  ${candidates.length} scheme page(s) found`);
  return { candidates, listings: [], pageTitle: 'myScheme', fetchedAt: new Date().toISOString() };
}

// ----------------------------------------------------------- extraction ----

/** Reads the labelled sections off a rendered scheme page. */
function readPage() {
  const clean = (s) => (s || '').replace(/ /g, ' ').trim();

  const name =
    clean(document.querySelector('h1')?.innerText)
    || clean(document.querySelector('[class*="schemeName"], [class*="scheme-name"]')?.innerText)
    || clean(document.querySelector('main h2, article h2')?.innerText)
    || clean(document.querySelector('meta[property="og:title"]')?.content)
    || clean(document.title).replace(/\s*[|\-–]\s*myScheme.*$/i, '').trim();

  const sections = {};
  document.querySelectorAll('h2, h3').forEach((h) => {
    const label = clean(h.innerText);
    if (!label) return;
    const parts = [];
    let el = h.nextElementSibling;
    while (el && !/^H[123]$/.test(el.tagName)) {
      parts.push(el.innerText);
      el = el.nextElementSibling;
    }
    const body = clean(parts.join('\n'));
    if (body) sections[label] = body;
  });

  // "Sources And References" carries the ministry's own page for the scheme.
  const references = [...document.querySelectorAll('a[href^="http"]')]
    .map((a) => a.href)
    .filter((href) => !href.includes('myscheme.gov.in'));

  const ministry = clean(
    document.querySelector('[class*="ministry"], [class*="Ministry"]')?.innerText
  ) || null;

  return { name, sections, references: [...new Set(references)], ministry };
}

const pick = (sections, ...names) => {
  for (const wanted of names) {
    const key = Object.keys(sections).find((k) => k.toLowerCase().includes(wanted));
    if (key) return sections[key];
  }
  return '';
};

export async function extract(candidate) {
  const check = checkUrl(candidate.url);
  if (!check.ok) return { scheme: null, error: `blocked: ${check.reason}` };

  let data;
  try {
    data = await withPage(async (page) => {
      log.debug(`    rendering ${candidate.url}`);

      // Two attempts. Government hosting is slow and a first load that returns
      // an empty shell usually succeeds on a retry; skipping on the first miss
      // was throwing away five pages in six.
      for (let attempt = 1; attempt <= 2; attempt++) {
        await page.goto(candidate.url, {
          waitUntil: attempt === 1 ? 'domcontentloaded' : 'networkidle',
        });

        /**
         * Wait for the content itself.
         *
         * networkidle is not readiness for a client-rendered page: the shell
         * settles while the body is still empty, and reading it there produced
         * a scheme with no name that was then skipped. The heading and the
         * eligibility section are the two things this adapter actually needs,
         * so wait until one of them exists.
         */
        try {
          await page.waitForFunction(() => {
            const heading = document.querySelector('h1')?.innerText?.trim();
            const body = document.body?.innerText ?? '';
            return Boolean(heading) || /Eligibility/i.test(body);
          }, { timeout: 20000 });
        } catch {
          if (attempt === 2) return null; // genuinely empty
          await pause(1500);
          continue;
        }

        await pause(600);
        const result = await page.evaluate(readPage);
        await pause(MIN_GAP_MS);
        if (result?.name) return result;
        if (attempt === 2) return result;
        await pause(1500);
      }
      return null;
    });
  } catch (err) {
    return { scheme: null, error: `render failed: ${err.message}` };
  }

  if (!data?.name) return { scheme: null, error: 'no scheme name on the rendered page' };

  const eligibility = pick(data.sections, 'eligibility');
  const benefits = pick(data.sections, 'benefit');
  const documents = pick(data.sections, 'document');
  const details = pick(data.sections, 'details', 'about');

  // The eligibility block comes first so the extractors read the criteria from
  // the section that states them, rather than from surrounding prose.
  const rawText = [eligibility, benefits, documents, details]
    .filter(Boolean).join('\n\n');

  if (rawText.length < 120) {
    return { scheme: null, error: `page text too short (${rawText.length} chars)` };
  }

  /**
   * Which government runs this scheme.
   *
   * Taken from the Details section and the scheme's own name — the two places
   * that name the implementing government — never from the eligibility text. A
   * clause like "applicants domiciled outside Assam are not eligible" mentions
   * a state without the scheme belonging to it, and mislabelling a national
   * scholarship as one state's would hide it from everybody else.
   */
  const attribution = `${data.name} ${details}`.slice(0, 900);
  const named = STATES.filter((state) => new RegExp(`\\b${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(attribution));
  // A scheme that calls itself national is national, whatever address appears
  // in its description. "Begum Hazrat Mahal National Scholarship" was being
  // filed under Delhi because its foundation is based there — which would have
  // hidden it from every student outside Delhi.
  const callsItselfNational =
    /\b(national|all[\s-]india|centrally sponsored|central sector|pan[\s-]india)\b/i
      .test(`${data.name} ${details.slice(0, 400)}`);

  // Exactly one state named means it is that state's scheme. Several means the
  // text is listing coverage, which makes it central.
  const state = !callsItselfNational && named.length === 1 ? named[0] : null;

  const extracted = extractAll(rawText);

  const scheme = toScheme({
    name: data.name,
    summary: (details || benefits || '').split('\n').filter(Boolean)[0]?.slice(0, 300) ?? null,
    // The scheme's page on myScheme IS the official link we hand a student. It
    // is a live government page that somebody maintains, which is exactly what
    // the ministry URLs harvested from stale indexes were not.
    sourceUrl: candidate.url,
    officialUrl: candidate.url,
    adapter: id,
    docType: 'html',
    rawText,
    extracted,
    level: state ? 'state' : 'central',
    state: state ?? candidate.state,
    ministry: data.ministry,
    fetchedAt: new Date().toISOString(),
  });

  // The ministry's own page is recorded, but not used as the apply link — those
  // are the URLs that rot.
  scheme.alternateSources = data.references.slice(0, 5).map((url) => ({ url, via: 'myscheme' }));

  return { scheme, error: null };
}
