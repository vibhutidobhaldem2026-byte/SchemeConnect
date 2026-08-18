/**
 * Server-side rendering helpers.
 *
 * Plain template literals with escaping by default — `h` escapes, `raw` opts
 * out explicitly. Everything scraped from a government site is untrusted input
 * and goes through `h`.
 */

import { daysUntil } from './matcher.js';

/** HTML-escape. Use for every interpolated value unless you mean raw markup. */
export function h(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marks a string as already-safe markup. */
export const raw = (s) => ({ __raw: String(s ?? '') });

/** Joins template parts, escaping anything that isn't raw(). */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v && typeof v === 'object' && '__raw' in v) out += v.__raw;
    else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.__raw : h(x))).join('');
    else out += h(v);
    out += strings[i + 1];
  }
  return out;
}

export function layout({ title, body, bodyClass = '', head = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${h(title)} · SchemeConnect</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/app.css">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0A2540">
${head}
</head>
<body class="${h(bodyClass)}">
${body}
<script src="/js/app.js" defer></script>
</body>
</html>`;
}

/**
 * The wordmark, with the brand image beside it.
 *
 * The source file is the full logo lock-up (emblem above the words), so the
 * emblem is cropped out of it in CSS rather than shipping a second asset —
 * see `.logo-img-wrap` in app.css. The `<img>` keeps real alt text, so if the
 * file is missing the mark still says what it is; app.js hides the frame
 * entirely on a load error so a broken-image glyph never sits next to the
 * wordmark.
 */
export const logoMark = (href = '/') => html`
  <a class="logo-mark" href="${href}">
    <span class="logo-img-wrap"><img src="/img/logo.jpeg" alt="SchemeConnect logo" decoding="async" data-logo></span>
    <span class="logo-word">SchemeConnect</span>
  </a>`;

/**
 * Sidebar icons.
 *
 * Inline SVG, not an icon font and not a script: it costs no extra request,
 * inherits `currentColor` so the active state colours itself, and stays sharp
 * on the cheap high-density screens the PRD targets. Anything unrecognised
 * falls back to a neutral dot rather than rendering an empty box.
 */
const NAV_ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.6V19a1.5 1.5 0 0 0 1.5 1.5h3v-5.2h4v5.2h3A1.5 1.5 0 0 0 18.5 19V9.6"/>',
  browse: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.4 15.4 4.1 4.1"/>',
  saved: '<path d="M6.5 4.8A1.5 1.5 0 0 1 8 3.3h8a1.5 1.5 0 0 1 1.5 1.5v15.9L12 17l-5.5 3.7z"/>',
  applied: '<path d="M9 4.8H7.5A1.5 1.5 0 0 0 6 6.3v13.4a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V6.3a1.5 1.5 0 0 0-1.5-1.5H15"/><rect x="9" y="2.7" width="6" height="4.2" rx="1.3"/><path d="m9.6 13.6 1.9 1.9 3.4-3.9"/>',
  profile: '<circle cx="12" cy="8.2" r="3.7"/><path d="M4.8 20.5a7.2 7.2 0 0 1 14.4 0"/>',
  terms: '<path d="M13.8 3.2H7.4A1.6 1.6 0 0 0 5.8 4.8v14.4a1.6 1.6 0 0 0 1.6 1.6h9.2a1.6 1.6 0 0 0 1.6-1.6V7.4z"/><path d="M13.8 3.2v4.2h4.4"/><path d="M9 12.8h6M9 16.2h4"/>',
  logout: '<path d="M9.6 20.5H6.4a1.6 1.6 0 0 1-1.6-1.6V5.1a1.6 1.6 0 0 1 1.6-1.6h3.2"/><path d="m15.4 16.2 4.3-4.2-4.3-4.2"/><path d="M19.7 12H9.4"/>',
  login: '<path d="M14.4 3.5h3.2a1.6 1.6 0 0 1 1.6 1.6v13.8a1.6 1.6 0 0 1-1.6 1.6h-3.2"/><path d="m8.6 16.2-4.3-4.2 4.3-4.2"/><path d="M4.3 12h10.3"/>',
  overview: '<rect x="3.6" y="3.6" width="7" height="7" rx="1.6"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.6"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.6"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.6"/>',
  batches: '<path d="m12 3.3 8.7 4.4L12 12.1 3.3 7.7z"/><path d="m3.3 12 8.7 4.4L20.7 12"/><path d="m3.3 16.3 8.7 4.4 8.7-4.4"/>',
  students: '<circle cx="9.2" cy="8" r="3.5"/><path d="M2.8 20.4a6.4 6.4 0 0 1 12.8 0"/><path d="M16.2 4.9a3.5 3.5 0 0 1 0 6.2"/><path d="M17.6 14.7a6.4 6.4 0 0 1 3.6 5.7"/>',
  upload: '<path d="M4.8 15.4v3.5a1.6 1.6 0 0 0 1.6 1.6h11.2a1.6 1.6 0 0 0 1.6-1.6v-3.5"/><path d="M12 15.2V3.6"/><path d="m7.6 8 4.4-4.4L16.4 8"/>',
  catalog: '<path d="M8 5.5h11.5M8 12h11.5M8 18.5h11.5"/><path d="M4.3 5.5h.01M4.3 12h.01M4.3 18.5h.01"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="m14.2 6.8 3 3"/>',
  export: '<path d="M12 3.6v11.2"/><path d="m7.6 10.4 4.4 4.4 4.4-4.4"/><path d="M4.8 17.2v1.7a1.6 1.6 0 0 0 1.6 1.6h11.2a1.6 1.6 0 0 0 1.6-1.6v-1.7"/>',
  coverage: '<path d="m9 3.6 6 2.6 5.2-2.6v14L15 20.4l-6-2.6-5.2 2.6v-14z"/><path d="M9 3.6v14.2M15 6.2v14.2"/>',
  sources: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6a12.5 12.5 0 0 1 0 16.8 12.5 12.5 0 0 1 0-16.8z"/>',
  runs: '<path d="M3.4 12.4h4l2.4-6.2 4 12.4 2.4-6.2h4.4"/>',
  back: '<path d="M20 12H4.4"/><path d="m10 5.9-5.9 6.1 5.9 6.1"/>',
};

export function navIcon(name) {
  const body = NAV_ICONS[name];
  if (!body) return '<svg class="ic ic-dot" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3.4"/></svg>';
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** One sidebar row. `key` picks both the active state and the icon. */
export function navItem({ key, label, href, icon = null, active = null }) {
  return html`
    <a class="nav-item ${active === key ? 'active' : ''}" href="${href}">${raw(navIcon(icon || key))}<span class="nav-label">${label}</span></a>`;
}

/** Student sidebar. */
export function studentNav(active) {
  const item = (key, label, href) => navItem({ key, label, href, active });
  return html`
    <nav class="side-nav" aria-label="Student navigation">
      ${raw(logoMark('/dashboard'))}
      ${raw(item('home', 'Home', '/dashboard'))}
      ${raw(item('browse', 'All schemes', '/schemes'))}
      ${raw(item('saved', 'Saved', '/saved'))}
      ${raw(item('applied', 'Applied', '/applied'))}
      ${raw(item('profile', 'My profile', '/profile'))}
      <div class="nav-spacer"></div>
      ${raw(item('terms', 'Terms', '/terms'))}
      ${raw(navItem({ key: 'logout', label: 'Log out', href: '/logout' }))}
    </nav>`;
}

/** Institute sidebar. */
export function instituteNav(active) {
  const item = (key, label, href) => navItem({ key, label, href, active });
  return html`
    <nav class="side-nav" aria-label="Institute navigation">
      ${raw(logoMark('/institute'))}
      ${raw(item('overview', 'Overview', '/institute'))}
      ${raw(item('batches', 'Batches', '/institute/batches'))}
      ${raw(item('students', 'Students', '/institute/students'))}
      ${raw(item('upload', 'Upload batch', '/institute/upload'))}
      <div class="nav-spacer"></div>
      ${raw(item('terms', 'Terms', '/terms'))}
      ${raw(navItem({ key: 'logout', label: 'Log out', href: '/logout' }))}
    </nav>`;
}

/**
 * The sidebar a signed-out visitor sees on public pages. Was duplicated,
 * slightly differently, in two routes.
 */
export function publicNav(active) {
  return html`
    <nav class="side-nav" aria-label="Navigation">
      ${raw(logoMark('/'))}
      ${raw(navItem({ key: 'login', label: 'Log in', href: '/start', active }))}
      <div class="nav-spacer"></div>
      ${raw(navItem({ key: 'terms', label: 'Terms', href: '/terms', active }))}
    </nav>`;
}

export function notice(kind, body) {
  return html`<div class="notice notice-${kind}">${raw(body)}</div>`;
}

export function formatINR(n) {
  if (n === null || n === undefined) return null;
  return '₹' + Number(n).toLocaleString('en-IN');
}

export function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Verified 3 days ago" freshness label — a core trust signal from the PRD. */
export function freshnessLabel(iso) {
  if (!iso) return 'Not yet verified';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (Number.isNaN(days)) return 'Not yet verified';
  if (days <= 0) return 'Verified today';
  if (days === 1) return 'Verified yesterday';
  if (days < 30) return `Verified ${days} days ago`;
  const months = Math.floor(days / 30);
  return `Verified ${months} month${months > 1 ? 's' : ''} ago`;
}

export function deadlineTag(scheme) {
  const days = daysUntil(scheme.deadline);
  if (days === null) return '';
  if (days < 0) return html`<span class="tag tag-danger">Closed ${-days}d ago</span>`;
  if (days <= 30) return html`<span class="tag tag-deadline">Closes in ${days}d · ${formatDate(scheme.deadline)}</span>`;
  return html`<span class="tag tag-deadline">Closes ${formatDate(scheme.deadline)}</span>`;
}

/**
 * A scheme card. `matchInfo` (from the matcher) adds the "why you matched"
 * line; without it the card renders as a plain catalog entry.
 */
export function schemeCard(scheme, matchInfo = null, { href = null } = {}) {
  const isListing = scheme.detailLevel === 'listing';
  const why = matchInfo?.passed?.length
    ? `Matched on ${matchInfo.passed.map((p) => p.label.toLowerCase()).join(', ')}`
    : null;

  return html`
    <a class="scheme-card" href="${href || `/schemes/${scheme.id}`}">
      <div class="sc-top">
        <div class="sc-name">${scheme.name}</div>
        ${raw(scheme.benefitText ? html`<div class="sc-amount">${scheme.benefitText}</div>` : '')}
      </div>
      <div class="sc-tags">
        <span class="tag tag-verified">✓ ${freshnessLabel(scheme.lastVerified)}</span>
        ${raw(deadlineTag(scheme))}
        ${raw(scheme.level === 'state' && scheme.state ? html`<span class="tag tag-match">${scheme.state}</span>` : '')}
        ${raw(isListing ? html`<span class="tag tag-locked">Criteria not yet read</span>` : '')}
        ${raw(why ? html`<span class="tag tag-match">${why}</span>` : '')}
      </div>
      ${raw(isListing
        ? html`<div class="sc-why">Listed on an official government page. We have the name and official link, but have not yet read its eligibility rules — open it to check on the government site.</div>`
        : '')}
    </a>`;
}

/** Renders the pass/fail/unknown criteria breakdown for a scheme. */
export function criteriaList(evaluation) {
  const row = (item, symbol, cls) => html`
    <li>
      <span class="${cls}">${symbol}</span>
      <span>
        <span class="crit-label">${item.label}</span> — ${item.detail}
        ${raw(item.evidence ? html`<span class="evidence">Source says: “${item.evidence}”</span>` : '')}
      </span>
    </li>`;

  return html`
    <ul class="criteria-list">
      ${raw(evaluation.passed.map((i) => row(i, '✓', 'crit-yes')).join(''))}
      ${raw(evaluation.failed.map((i) => row(i, '✕', 'crit-no')).join(''))}
      ${raw(evaluation.unknown.map((i) => row(i, '?', 'crit-unknown')).join(''))}
    </ul>`;
}

/**
 * The criteria a scheme states, independent of any student profile, each with
 * the source sentence it was read from.
 *
 * Shown to signed-out visitors and anyone without a complete profile: the
 * source evidence is the product's main trust signal, so it should not be
 * gated behind an account.
 */
export function statedCriteria(scheme) {
  const e = scheme.eligibility;
  const evidenceFor = (field) => scheme.criteriaEvidence?.find((c) => c.field === field)?.text ?? null;

  const items = [];
  if (e.maxFamilyIncome !== null) {
    items.push({ label: 'Family income', detail: `At or below ${formatINR(e.maxFamilyIncome)} per year.`, field: 'maxFamilyIncome' });
  }
  if (e.categories.length) {
    items.push({ label: 'Category', detail: `Open to ${e.categories.join(', ')}.`, field: 'categories' });
  }
  if (e.courseLevels.length) {
    items.push({ label: 'Course level', detail: `Applies to ${e.courseLevels.join(', ')}.`, field: 'courseLevels' });
  }
  if (e.gender.length) {
    items.push({ label: 'Gender', detail: `Restricted to ${e.gender.join('/')} students.`, field: 'gender' });
  }
  if (e.disabilityRequired) {
    items.push({ label: 'Disability', detail: 'For students with disabilities.', field: 'disabilityRequired' });
  }
  if (e.minMarksPercent !== null) {
    items.push({ label: 'Marks', detail: `At least ${e.minMarksPercent}% in the qualifying exam.`, field: 'minMarksPercent' });
  }
  if (e.states.length) {
    items.push({ label: 'State', detail: `Residents of ${e.states.join(', ')}.`, field: 'states' });
  }

  if (!items.length) return '';

  return html`
    <ul class="criteria-list">
      ${raw(items.map((i) => {
        const ev = evidenceFor(i.field);
        return html`
          <li>
            <span class="crit-unknown">•</span>
            <span>
              <span class="crit-label">${i.label}</span> — ${i.detail}
              ${raw(ev ? html`<span class="evidence">Source says: “${ev}”</span>` : '')}
            </span>
          </li>`;
      }).join(''))}
    </ul>`;
}

/**
 * `art` names a full illustration (see ILLUSTRATIONS) and wins when given.
 * Otherwise `icon` is a key into SPOT_ART; an unknown key — including the
 * emoji these call sites used to pass — still renders, escaped, so no caller
 * can break by naming a drawing that does not exist.
 */
export function emptyState(icon, title, sub, art = null) {
  const mark = art && ILLUSTRATIONS[art]
    ? html`<div class="es-illus">${raw(illustration(art))}</div>`
    : html`<div class="es-icon">${raw(spotArt(icon) || h(icon))}</div>`;
  return html`
    <div class="empty-state">
      ${raw(mark)}
      <div class="es-title">${title}</div>
      <div class="es-sub">${raw(sub)}</div>
    </div>`;
}

/** Banner shown when the catalog is missing or stale. */
export function catalogBanner(meta, ageDays) {
  if (!meta.exists || meta.total === 0) {
    return notice('danger', html`
      <b>No scheme data yet.</b> The catalog is produced entirely by the government scraper, and it has not
      been run. Run <span class="mono">npm run scrape</span> to populate it. Nothing on this site is
      hand-authored, so until then there are no schemes to show.`);
  }
  if (ageDays !== null && ageDays > 180) {
    return notice('warn', html`
      <b>This catalog is ${ageDays} days old.</b> Government schemes change without notice — treat these
      dates and amounts as indicative and confirm on the official page. Re-run
      <span class="mono">npm run scrape</span> to refresh.`);
  }
  return '';
}

/* ======================================================== illustration =====
 *
 * Original line-art drawn for this product. The rules it follows:
 *
 *  - Inline SVG only. The CSP is `script-src 'self'` / `img-src 'self' data:`,
 *    and the PRD targets a 2GB Android over 2G — so no icon font, no CDN, no
 *    second request. Inlining also means the art inherits the page's colours.
 *  - Geometry, not character. This is a government-adjacent product; strokes,
 *    rectangles and arcs read as credible where a mascot would not.
 *  - Colour lives in CSS, not in the path data. Shapes carry semantic classes
 *    (`sa-tint`, `sa-accent`) that app.css maps onto the existing custom
 *    properties, so the palette is changed in one place.
 *  - Every drawing is decorative unless it is the only thing carrying its
 *    meaning, so all of these are `aria-hidden` — the heading beside them is
 *    what a screen reader should read. The hero is the exception and carries a
 *    <title>.
 */

/**
 * 48x48 spot drawings: empty states, and the "how it works" steps.
 * Kept on one grid so a single wrapper can render all of them.
 */
const SPOT_ART = {
  // --- empty states ---
  search: '<circle class="sa-tint" cx="21" cy="21" r="13"/><path d="M16 21h10"/><path class="sa-accent" d="m30.8 30.8 10.2 10.2" stroke-width="2.6"/>',
  bookmark: '<path class="sa-tint" d="M14 7h20a2 2 0 0 1 2 2v32l-12-8.4L12 41V9a2 2 0 0 1 2-2z"/>',
  document: '<path class="sa-tint" d="M13 6h13.5L35 14.5V40a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M26.5 6v8.5H35"/><path d="M17 25h12M17 32h8"/>',
  students: '<circle class="sa-accent" cx="33" cy="16" r="5.5"/><path class="sa-accent" d="M24.5 39.5a8.5 8.5 0 0 1 17 0"/><circle class="sa-tint sa-solid" cx="18" cy="17" r="7"/><path class="sa-tint sa-solid" d="M6 40.5a12 12 0 0 1 24 0z"/>',
  batches: '<path class="sa-tint" d="m24 6 17 8.5L24 23 7 14.5z"/><path d="m7 23.5 17 8.5 17-8.5"/><path class="sa-accent" d="m7 32.5 17 8.5 17-8.5"/>',
  map: '<path class="sa-tint" d="M17 8l14 5 10-5v27l-10 5-14-5-9 5V13z"/><path d="M17 8v27M31 13v27"/>',
  clock: '<circle class="sa-tint" cx="24" cy="24" r="16"/><path class="sa-accent" d="M24 14v10l7 4"/>',

  // --- "how it works" steps ---
  // 1. six questions, one per screen — a form with one answer chosen.
  'step-ask': '<rect class="sa-tint" x="8" y="6" width="32" height="36" rx="4"/><circle cx="16" cy="17" r="3"/><path d="M23 17h11"/><circle class="sa-dot" cx="16" cy="26" r="3"/><path d="M23 26h11"/><circle cx="16" cy="35" r="3"/><path d="M23 35h8"/>',
  // 2. rules laid out one by one: met, not met, could not read.
  'step-check': '<rect class="sa-tint" x="6" y="7" width="36" height="34" rx="4"/><path class="sa-accent" d="m10.8 16 2.6 2.6L18 13.6"/><path d="M23 16h14"/><path d="m11.2 23.2 4.4 4.4m0-4.4-4.4 4.4"/><path d="M23 25.4h11"/><circle cx="13.4" cy="34.4" r="2.6"/><path d="M23 34.4h13"/>',
  // 3. you leave for the government's own portal.
  'step-apply': '<path d="M6 41h36"/><path class="sa-tint" d="M24 13 41 23H7z"/><path d="M9.5 37h29"/><path d="M13 26v11M20 26v11M28 26v11M35 26v11"/><path class="sa-accent" d="M32 3h9v9M41 3l-8.5 8.5"/>',
};

/**
 * One 48x48 spot drawing. Returns '' for an unknown name so callers can fall
 * back rather than render an empty box.
 */
export function spotArt(name, cls = 'spot') {
  const body = SPOT_ART[name];
  if (!body) return '';
  return `<svg class="${cls}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * The full illustrations, held as files rather than inlined: they are an order
 * of magnitude larger than the spot drawings above, so they belong in the HTTP
 * cache where a repeat visit costs nothing, not re-sent inside every page.
 *
 * `w`/`h` are the file's intrinsic size. They are on the tag purely so the
 * browser can reserve the right box before the file arrives — CSS decides the
 * size that is actually drawn. Without them a slow connection reflows the page
 * under the reader, which is exactly the connection the PRD targets.
 *
 * All four are decorative: the heading beside each one already says what it
 * says, so they are aria-hidden with an empty alt.
 */
export const ILLUSTRATIONS = {
  hero: { src: '/img/education_3vwh.svg', w: 744, h: 539 },
  verified: { src: '/img/certification_oqiz.svg', w: 429, h: 567 },
  certificate: { src: '/img/certificate_cqps.svg', w: 466, h: 757 },
  researching: { src: '/img/researching_49yy.svg', w: 800, h: 521 },
};

export function illustration(name, { cls = '', lazy = true } = {}) {
  const a = ILLUSTRATIONS[name];
  if (!a) return '';
  return `<img class="illus ${cls}" src="${a.src}" alt="" aria-hidden="true"`
    + ` width="${a.w}" height="${a.h}" decoding="async"${lazy ? ' loading="lazy"' : ''}>`;
}
