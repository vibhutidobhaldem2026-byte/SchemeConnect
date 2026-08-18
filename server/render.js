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

export const logoMark = (href = '/') => html`
  <a class="logo-mark" href="${href}"><span class="logo-dot"></span><span class="logo-word">SchemeConnect</span></a>`;

/** Student sidebar. */
export function studentNav(active) {
  const item = (key, label, href) => html`
    <a class="nav-item ${active === key ? 'active' : ''}" href="${href}"><span class="ic"></span>${label}</a>`;
  return html`
    <nav class="side-nav">
      ${raw(logoMark('/dashboard'))}
      ${raw(item('home', 'Home', '/dashboard'))}
      ${raw(item('browse', 'All schemes', '/schemes'))}
      ${raw(item('saved', 'Saved', '/saved'))}
      ${raw(item('applied', 'Applied', '/applied'))}
      ${raw(item('profile', 'My profile', '/profile'))}
      <div class="nav-spacer"></div>
      ${raw(item('terms', 'Terms', '/terms'))}
      <a class="nav-item" href="/logout"><span class="ic"></span>Log out</a>
    </nav>`;
}

/** Institute sidebar. */
export function instituteNav(active) {
  const item = (key, label, href) => html`
    <a class="nav-item ${active === key ? 'active' : ''}" href="${href}"><span class="ic"></span>${label}</a>`;
  return html`
    <nav class="side-nav">
      ${raw(logoMark('/institute'))}
      ${raw(item('overview', 'Overview', '/institute'))}
      ${raw(item('batches', 'Batches', '/institute/batches'))}
      ${raw(item('students', 'Students', '/institute/students'))}
      ${raw(item('upload', 'Upload batch', '/institute/upload'))}
      <div class="nav-spacer"></div>
      ${raw(item('terms', 'Terms', '/terms'))}
      <a class="nav-item" href="/logout"><span class="ic"></span>Log out</a>
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

export function emptyState(icon, title, sub) {
  return html`
    <div class="empty-state">
      <div class="es-icon">${icon}</div>
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
