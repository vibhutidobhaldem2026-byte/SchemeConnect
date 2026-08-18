/**
 * Operations dashboard. Mounted at /ops.
 *
 * The PRD asks for coverage-gap tracking so the team knows which states cannot
 * be served before a student finds out the hard way. This surfaces that, plus
 * scraper run history, source health, and what the last run rejected — the
 * rejection list is the main signal for improving the extractors.
 */

import express from 'express';
import { html, raw, layout, logoMark, notice, formatDate, emptyState } from '../render.js';
import {
  allSchemes, catalogMeta, catalogAgeDays, searchSchemes, getScheme,
  setOverride, clearOverride, schemeRevisions, allSchemesForExport, listSources,
} from '../catalog.js';
import { SOURCES } from '../../config/sources.js';
import { ALLOWLIST_DESCRIPTION } from '../../scraper/lib/allowlist.js';
import * as store from '../store.js';

export const router = express.Router();

/**
 * The ops dashboard was completely unauthenticated: anyone who visited /ops saw
 * registered user counts, minor-consent counts and the full source
 * configuration. Every other router opened with a guard; this one had none.
 *
 * Access is granted two ways. OPS_EMAILS is the bootstrap — a comma-separated
 * allowlist so a fresh deployment has a way in without a seeded account. Beyond
 * that, an account whose role is 'ops' qualifies.
 */
const opsAllowlist = () =>
  new Set(
    String(process.env.OPS_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );

export function isOps(user) {
  if (!user) return false;
  if (user.role === 'ops') return true;
  const allowed = opsAllowlist();
  return allowed.has(String(user.identifier).toLowerCase())
    || (user.email ? allowed.has(String(user.email).toLowerCase()) : false);
}

function requireOps(req, res, next) {
  if (!req.user) return res.redirect('/start');
  if (!isOps(req.user)) {
    // next('router') leaves this router entirely, so the request falls through
    // to the site 404. A bare next() would have advanced to the next handler
    // *inside* this router — which is the dashboard it was meant to protect.
    //
    // A 404 rather than a 403: an authenticated student learns nothing about
    // whether this path exists.
    return next('router');
  }
  next();
}
router.use(requireOps);

function opsNav(active) {
  const item = (key, label, href) => html`
    <a class="nav-item ${active === key ? 'active' : ''}" href="${href}"><span class="ic"></span>${label}</a>`;
  return html`
    <nav class="side-nav">
      ${raw(logoMark('/'))}
      ${raw(item('catalog', 'Catalogue', '/ops'))}
      ${raw(item('edit', 'Correct a scheme', '/ops/schemes'))}
      ${raw(item('export', 'Export', '/ops/export'))}
      ${raw(item('coverage', 'Coverage', '/ops/coverage'))}
      ${raw(item('sources', 'Sources', '/ops/sources'))}
      ${raw(item('runs', 'Scrape runs', '/ops/runs'))}
      <div class="nav-spacer"></div>
      <a class="nav-item" href="/"><span class="ic"></span>Back to site</a>
    </nav>`;
}

router.get('/', async (req, res) => {
  const meta = await catalogMeta();
  const ageDays = await catalogAgeDays();
  const schemes = await allSchemes();
  const appStats = await store.stats();

  const byConfidence = [
    { label: 'High (0.6 and above)', n: schemes.filter((s) => s.confidence >= 0.6).length },
    { label: 'Medium (0.3 to 0.6)', n: schemes.filter((s) => s.confidence >= 0.3 && s.confidence < 0.6).length },
    { label: 'Low (below 0.3, with criteria)', n: schemes.filter((s) => s.confidence < 0.3 && s.detailLevel === 'full').length },
    { label: 'Listing only (no criteria)', n: meta.listingOnly },
  ];

  res.send(layout({
    title: 'Ops — catalogue',
    body: html`
      <div class="app-shell">
        ${raw(opsNav('catalog'))}
        <main class="main-area">
          <div class="greeting">Catalogue health</div>
          <div class="greeting-sub">
            Every figure here describes data produced by the scraper. Nothing in this product is hand-authored.
          </div>

          ${raw(!meta.exists
            ? notice('danger', html`<b>No catalogue file.</b> Run <span class="mono">npm run scrape</span>.`)
            : ageDays > 180
              ? notice('warn', html`<b>Catalogue is ${ageDays} days old.</b> Re-run the scraper.`)
              : notice('good', html`Catalogue generated ${formatDate(meta.generatedAt)}${ageDays !== null ? ` (${ageDays} day${ageDays === 1 ? '' : 's'} ago)` : ''}.`))}

          <div class="ops-grid">
            <div class="stat-card"><div class="stat-num">${meta.total}</div><div class="stat-label">Schemes in catalogue</div></div>
            <div class="stat-card"><div class="stat-num">${meta.matchable}</div><div class="stat-label">With machine-readable criteria</div></div>
            <div class="stat-card"><div class="stat-num">${meta.listingOnly}</div><div class="stat-label">Listing only</div></div>
            <div class="stat-card"><div class="stat-num">${meta.withDeadline}</div><div class="stat-label">With a parsed deadline</div></div>
            <div class="stat-card"><div class="stat-num">${meta.central}</div><div class="stat-label">Central</div></div>
            <div class="stat-card"><div class="stat-num">${meta.state}</div><div class="stat-label">State</div></div>
          </div>

          <div class="section-label">Extraction confidence</div>
          <div class="info-card">
            ${raw(byConfidence.map((b) => html`
              <div class="info-row"><span class="k">${b.label}</span><span class="v">${b.n}</span></div>`).join(''))}
            <div class="hint" style="margin-top:12px;font-size:12px;color:var(--muted)">
              Confidence is the share of six signals (income ceiling, categories, course level, benefit amount,
              deadline, documents) the parser could read from the source.
            </div>
          </div>

          <div class="section-label">Government domains crawled</div>
          <div class="info-card">
            ${raw(meta.sources.length
              ? meta.sources.map((d) => html`<div class="info-row"><span class="k mono">${d}</span><span class="v">
                  ${schemes.filter((s) => s.source?.domain === d).length} schemes</span></div>`).join('')
              : '<div class="hint">No sources yet.</div>')}
            <div class="hint" style="margin-top:12px;font-size:12px;color:var(--muted)">
              Scraper policy: ${ALLOWLIST_DESCRIPTION}.
            </div>
          </div>

          <div class="section-label">Application data</div>
          <div class="ops-grid">
            <div class="stat-card"><div class="stat-num">${appStats.students}</div><div class="stat-label">Student accounts</div></div>
            <div class="stat-card"><div class="stat-num">${appStats.institutes}</div><div class="stat-label">Institutes</div></div>
            <div class="stat-card"><div class="stat-num">${appStats.batches}</div><div class="stat-label">Batches uploaded</div></div>
            <div class="stat-card"><div class="stat-num">${appStats.minorConsents}</div><div class="stat-label">Guardian consents recorded</div></div>
          </div>
        </main>
      </div>`,
  }));
});

router.get('/coverage', async (req, res) => {
  const meta = await catalogMeta();
  const coverage = meta.coverage;

  res.send(layout({
    title: 'Ops — coverage',
    body: html`
      <div class="app-shell">
        ${raw(opsNav('coverage'))}
        <main class="main-area">
          <div class="greeting">State coverage</div>
          <div class="greeting-sub">
            Which states we can honestly serve. Per the PRD, a student in a state with no verified scheme is told
            we have no data — never shown an empty list they might read as "you qualify for nothing".
          </div>

          ${raw(!coverage
            ? emptyState('🗺️', 'No coverage data', 'Run <span class="mono">npm run scrape</span> to generate it.')
            : html`
            <div class="ops-grid">
              <div class="stat-card"><div class="stat-num">${coverage.centralSchemes}</div>
                <div class="stat-label">Central schemes (apply everywhere)</div></div>
              <div class="stat-card"><div class="stat-num">${coverage.statesWithStateSchemes.length}</div>
                <div class="stat-label">States with a state-level scheme</div></div>
              <div class="stat-card"><div class="stat-num">${coverage.statesWithoutStateSchemes.length}</div>
                <div class="stat-label">States with none yet</div></div>
            </div>

            ${raw(notice('warn', html`
              <b>${coverage.statesWithoutStateSchemes.length} of ${coverage.totalStates} states and UTs have no
              state-level scheme in the catalogue.</b> Students there are matched against central schemes only,
              and the dashboard tells them so explicitly.`))}

            <div class="section-label">States with state-level schemes</div>
            <div class="info-card">
              ${raw(coverage.perState.filter((s) => s.schemes > 0).length
                ? coverage.perState.filter((s) => s.schemes > 0)
                    .map((s) => html`<div class="info-row"><span class="k">${s.state}</span>
                      <span class="v">${s.schemes} state · ${s.central} central</span></div>`).join('')
                : '<div class="hint">None yet — every scheme in the catalogue is central.</div>')}
            </div>

            <div class="section-label">Not yet covered at state level</div>
            <div class="info-card">
              <div class="sc-tags">
                ${raw(coverage.statesWithoutStateSchemes.map((s) => `<span class="tag tag-locked">${s}</span>`).join(''))}
              </div>
            </div>`)}
        </main>
      </div>`,
  }));
});

router.get('/sources', async (req, res) => {
  const enabled = SOURCES.filter((s) => s.enabled !== false);
  const disabled = SOURCES.filter((s) => s.enabled === false);
  const schemes = await allSchemes();

  res.send(layout({
    title: 'Ops — sources',
    body: html`
      <div class="app-shell">
        ${raw(opsNav('sources'))}
        <main class="main-area">
          <div class="greeting">Sources</div>
          <div class="greeting-sub">
            Configured government sources. The scraper refuses to run if any configured source is not a
            government domain — the check is static and runs before any network activity.
          </div>

          ${raw(notice('info', html`<b>Policy:</b> ${ALLOWLIST_DESCRIPTION}. robots.txt is honoured,
            requests to a host are serialised with a minimum 2s gap, and redirects off a government domain
            are rejected.`))}

          <div class="section-label">Active (${enabled.length})</div>
          <div class="info-card">
            ${raw(enabled.map((s) => {
              const host = new URL(s.url).hostname;
              const n = schemes.filter((x) => x.sourceId === s.id).length;
              return html`
                <div class="src-row">
                  <div>
                    <div style="font-weight:700;color:var(--navy)">${s.label}</div>
                    <div class="mono" style="color:var(--muted);margin-top:3px">${host}</div>
                  </div>
                  <div><span class="pill ${n ? 'pill-active' : 'pill-none'}">${n} schemes</span></div>
                </div>`;
            }).join(''))}
          </div>

          <div class="section-label">Disabled (${disabled.length})</div>
          <div class="info-card">
            ${raw(disabled.length ? disabled.map((s) => html`
              <div class="src-row">
                <div>
                  <div style="font-weight:700;color:var(--navy)">${s.label}</div>
                  <div class="mono" style="color:var(--muted);margin-top:3px">${new URL(s.url).hostname}</div>
                </div>
                <div class="src-reason">${s.disabledReason}</div>
              </div>`).join('') : '<div class="hint">None.</div>')}
            <div class="hint" style="margin-top:14px;font-size:12px;color:var(--muted)">
              These stay in the config rather than being deleted, so the reason is recorded. Most are government
              sites serving an incomplete TLS chain; we do not disable certificate verification to work around
              that. Re-test them with <span class="mono">node scraper/probe.js</span>.
            </div>
          </div>
        </main>
      </div>`,
  }));
});

router.get('/runs', async (req, res) => {
  const meta = await catalogMeta();
  const runs = meta.runs ?? [];
  const last = runs[0];

  res.send(layout({
    title: 'Ops — scrape runs',
    body: html`
      <div class="app-shell">
        ${raw(opsNav('runs'))}
        <main class="main-area">
          <div class="greeting">Scrape runs</div>
          <div class="greeting-sub">History of the last ${runs.length} runs, newest first.</div>

          ${raw(!runs.length
            ? emptyState('⏱️', 'No runs recorded', 'Run <span class="mono">npm run scrape</span>.')
            : html`
            <div class="table-wrap" style="margin-bottom:24px">
              <table>
                <tr><th>Started</th><th>Duration</th><th>Sources</th><th>Examined</th><th>Kept</th><th>Rejected</th><th>Outcome</th></tr>
                ${raw(runs.map((r) => html`
                  <tr>
                    <td>${formatDate(r.startedAt)} ${new Date(r.startedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>${r.durationSec}s</td>
                    <td>${r.sourcesCrawled?.length ?? 0}</td>
                    <td>${r.candidatesExamined}</td>
                    <td>${r.schemesKept}</td>
                    <td>${r.rejectedCount}</td>
                    <td><span class="pill ${r.dryRun ? 'pill-none' : r.outcome === 'written' ? 'pill-active' : 'pill-pending'}">
                      ${r.dryRun ? 'dry run' : r.outcome || 'done'}</span></td>
                  </tr>`).join(''))}
              </table>
            </div>

            ${raw(last?.sourceErrors?.length ? html`
              <div class="section-label">Source failures in the last run</div>
              <div class="info-card">
                ${raw(last.sourceErrors.map((e) => html`
                  <div class="src-row"><div class="mono">${e.source}</div><div class="src-reason">${e.error}</div></div>`).join(''))}
              </div>` : '')}

            ${raw(last?.rejected?.length ? html`
              <div class="section-label">What the last run rejected (${last.rejectedCount})</div>
              <p class="greeting-sub" style="margin-bottom:14px">
                The most useful signal for improving the extractors. A page rejected for "no eligibility criterion"
                is usually a real scheme whose wording the parser did not recognise.
              </p>
              <div class="info-card">
                ${raw(last.rejected.slice(0, 40).map((r) => html`
                  <div class="src-row">
                    <div style="max-width:55%">
                      <div style="font-weight:600">${r.name || '(no name parsed)'}</div>
                      <div class="mono" style="color:var(--muted);margin-top:3px;word-break:break-all">${(r.url || '').slice(0, 90)}</div>
                    </div>
                    <div class="src-reason">${r.reason}</div>
                  </div>`).join(''))}
              </div>` : '')}`)}
        </main>
      </div>`,
  }));
});

// ------------------------------------------------- catalogue corrections ---

/**
 * The write path the PRD asks for and the build never had.
 *
 * PRD §2.1: "An operations team member reviews a scheme flagged as not
 * re-verified since the last academic year, confirms the income limit has
 * changed, and updates the catalogue before the new application window opens."
 * Until now that meant editing a JSON file, committing it and redeploying.
 *
 * A correction is stored as an overlay in scheme_overrides, never written over
 * the scraped row. The provenance the whole product rests on — "read from
 * socialjustice.gov.in on 18 Aug, here is the sentence" — survives underneath,
 * and the scheme page shows both.
 */

/** Fields ops may correct, and how each is parsed out of the form. */
const EDITABLE = {
  name: {
    label: 'Scheme name',
    read: (s) => s.name,
    parse: (v) => (v.trim() ? v.trim() : null),
  },
  benefit_text: {
    label: 'Benefit',
    read: (s) => s.benefitText,
    parse: (v) => (v.trim() ? v.trim() : null),
  },
  deadline: {
    label: 'Application deadline',
    hint: 'YYYY-MM-DD, or blank if the scheme has no published deadline.',
    read: (s) => s.deadline,
    parse: (v) => {
      const t = v.trim();
      if (!t) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error('Enter the date as YYYY-MM-DD.');
      if (Number.isNaN(Date.parse(t))) throw new Error('That is not a real date.');
      return t;
    },
  },
  apply_url: {
    label: 'Official application URL',
    read: (s) => s.applyUrl,
    parse: (v) => {
      const t = v.trim();
      if (!t) return null;
      let url;
      try {
        url = new URL(t);
      } catch {
        throw new Error('That is not a valid URL.');
      }
      // Same rule the scraper enforces: we only ever link to a government page.
      if (url.protocol !== 'https:' || !/\.(gov|nic)\.in$/.test(url.hostname)) {
        throw new Error('The apply link must be an https .gov.in or .nic.in address.');
      }
      return t;
    },
  },
};

/** The income limit is one key inside the eligibility object, not a column. */
const INCOME_FIELD = 'eligibility';

router.get('/schemes', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { schemes, total } = await searchSchemes({ q, level: 'all', limit: 60 });

  res.send(layout({
    title: 'Correct a scheme',
    body: html`
      <div class="app-shell">
        ${raw(opsNav('edit'))}
        <main class="main-area">
          <div class="greeting">Correct a scheme</div>
          <div class="greeting-sub">
            Corrections are stored as an overlay. What the scraper read stays on the record underneath,
            so a scheme's page can show both the government source and what we changed.
          </div>

          <form class="search-bar" method="get" action="/ops/schemes">
            <span class="ic">🔍</span>
            <input name="q" value="${q}" placeholder="Search by scheme name or ministry">
            <button type="submit">Search</button>
          </form>

          <div class="section-label">${total} scheme${total === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''}</div>

          <div class="table-wrap">
            <table>
              <tr><th>Scheme</th><th>Level</th><th>Tier</th><th>Last verified</th><th>Corrections</th></tr>
              ${raw(schemes.map((s) => html`
                <tr class="clickable" data-href="/ops/schemes/${s.id}">
                  <td class="b"><a class="row-link" href="/ops/schemes/${s.id}">${s.name}</a></td>
                  <td>${s.level === 'state' ? s.state || 'State' : 'Central'}</td>
                  <td><span class="pill ${s.detailLevel === 'full' ? 'pill-active' : 'pill-none'}">
                    ${s.detailLevel === 'full' ? 'Matchable' : 'Listing only'}</span></td>
                  <td>${formatDate(s.lastVerified)}</td>
                  <td>${Object.keys(s.corrections).length || '—'}</td>
                </tr>`).join(''))}
            </table>
          </div>
          ${raw(total > schemes.length
            ? html`<p class="foot-note">Showing the first ${schemes.length} of ${total}. Narrow your search to see more.</p>`
            : '')}
        </main>
      </div>`,
  }));
});

router.get('/schemes/:id', async (req, res, next) => {
  const scheme = await getScheme(req.params.id);
  if (!scheme) return next();

  const revisions = await schemeRevisions(scheme.id);
  const error = req.query.error;
  const saved = req.query.saved;
  const income = scheme.eligibility?.maxFamilyIncome ?? null;

  const field = (key, spec) => {
    const correction = scheme.corrections[key];
    return html`
      <div class="field">
        <label for="f_${key}">${spec.label}</label>
        <input id="f_${key}" name="${key}" type="text" value="${spec.read(scheme) ?? ''}">
        ${raw(spec.hint ? html`<div class="hint">${spec.hint}</div>` : '')}
        ${raw(correction ? html`
          <div class="hint" style="color:var(--muted)">
            Corrected ${formatDate(correction.editedAt)} — the source said
            <span class="mono">${correction.was ?? '(nothing)'}</span>. Reason: ${correction.reason}
          </div>` : '')}
      </div>`;
  };

  res.send(layout({
    title: `Correct — ${scheme.name}`,
    body: html`
      <div class="app-shell">
        ${raw(opsNav('edit'))}
        <main class="main-area narrow">
          <a class="link-back" href="/ops/schemes">← Back to catalogue</a>
          <div class="greeting" style="font-size:22px;">${scheme.name}</div>
          <div class="greeting-sub">
            ${scheme.ministry || (scheme.level === 'central' ? 'Central scheme' : `${scheme.state} state scheme`)}
            · last verified ${formatDate(scheme.lastVerified)}
          </div>

          ${raw(error ? notice('danger', html`${error}`) : '')}
          ${raw(saved ? notice('good', html`Correction saved. The scheme page shows it alongside the source.`) : '')}

          ${raw(notice('info', html`
            <b>This does not change what the scraper read.</b> Your correction is stored on top of it, with
            your reason and a timestamp, and can be reverted. The scheme's page keeps showing the government
            source and the sentence each criterion came from.`))}

          <form method="post" action="/ops/schemes/${scheme.id}">
            <div class="info-card">
              <h3>Details</h3>
              ${raw(Object.entries(EDITABLE).map(([key, spec]) => field(key, spec)).join(''))}
            </div>

            <div class="info-card">
              <h3>Eligibility</h3>
              <div class="field">
                <label for="f_income">Maximum family income (₹ per year)</label>
                <input id="f_income" name="maxFamilyIncome" type="text" inputmode="numeric"
                       value="${income ?? ''}">
                <div class="hint">
                  Blank means the source states no income limit. This is the field the PRD's ops
                  scenario is about — a limit that changed before the application window opened.
                </div>
                ${raw(scheme.corrections[INCOME_FIELD] ? html`
                  <div class="hint" style="color:var(--muted)">
                    Eligibility was corrected ${formatDate(scheme.corrections[INCOME_FIELD].editedAt)}.
                    Reason: ${scheme.corrections[INCOME_FIELD].reason}
                  </div>` : '')}
              </div>
            </div>

            <div class="info-card">
              <h3>Why</h3>
              <div class="field" style="margin-bottom:0">
                <label for="reason">Reason for this correction</label>
                <input id="reason" name="reason" type="text" required
                       placeholder="e.g. Income limit raised to ₹3,00,000 in the 2026-27 circular">
                <div class="hint">Recorded against the change. Say what you checked, and where.</div>
              </div>
            </div>

            <button class="btn-primary btn-inline" type="submit">Save correction</button>
          </form>

          ${raw(Object.keys(scheme.corrections).length ? html`
            <form method="post" action="/ops/schemes/${scheme.id}/revert" style="margin-top:14px">
              <input type="hidden" name="reason" value="Reverted to the scraped value">
              <button class="btn-ghost" type="submit">Revert every correction on this scheme</button>
            </form>` : '')}

          <div class="info-card" style="margin-top:24px">
            <h3>Where this came from</h3>
            <div class="info-row"><span class="k">Source</span>
              <span class="v"><a href="${scheme.source.url}" target="_blank" rel="noopener noreferrer">${scheme.source.domain}</a></span></div>
            <div class="info-row"><span class="k">Extraction confidence</span>
              <span class="v">${Math.round((scheme.confidence ?? 0) * 100)}%</span></div>
            <div class="info-row"><span class="k">Tier</span>
              <span class="v">${scheme.detailLevel === 'full' ? 'Matchable' : 'Listing only'}</span></div>
          </div>

          ${raw(revisions.length ? html`
            <div class="section-label">Correction history</div>
            <div class="table-wrap">
              <table>
                <tr><th>Field</th><th>From</th><th>To</th><th>Reason</th><th>When</th></tr>
                ${raw(revisions.map((r) => html`
                  <tr>
                    <td class="b">${r.field}</td>
                    <td class="mono">${JSON.stringify(r.old_value) ?? '—'}</td>
                    <td class="mono">${JSON.stringify(r.new_value) ?? '(reverted)'}</td>
                    <td>${r.reason || '—'}</td>
                    <td>${formatDate(r.edited_at)}</td>
                  </tr>`).join(''))}
              </table>
            </div>` : '')}
        </main>
      </div>`,
  }));
});

router.post('/schemes/:id', async (req, res, next) => {
  const scheme = await getScheme(req.params.id);
  if (!scheme) return next();

  const reason = String(req.body.reason || '').trim();
  const fail = (msg) =>
    res.redirect(`/ops/schemes/${scheme.id}?error=${encodeURIComponent(msg)}`);

  if (reason.length < 5) return fail('Please say why you are making this correction.');

  const edits = [];
  try {
    for (const [key, spec] of Object.entries(EDITABLE)) {
      if (!(key in req.body)) continue;
      const value = spec.parse(String(req.body[key] ?? ''));
      // Only record a change. Re-saving an unchanged form should not fill the
      // history with no-ops.
      if (JSON.stringify(value) === JSON.stringify(spec.read(scheme) ?? null)) continue;
      edits.push([key, value]);
    }

    const rawIncome = String(req.body.maxFamilyIncome ?? '').replace(/[^\d]/g, '');
    const income = rawIncome ? Number(rawIncome) : null;
    if (rawIncome && (!Number.isFinite(income) || income <= 0)) {
      return fail('Enter the income limit as a number of rupees, or leave it blank.');
    }
    if (income !== (scheme.eligibility?.maxFamilyIncome ?? null)) {
      edits.push([INCOME_FIELD, { ...scheme.eligibility, maxFamilyIncome: income }]);
    }
  } catch (err) {
    return fail(err.message);
  }

  if (!edits.length) return fail('Nothing changed.');

  for (const [field, value] of edits) {
    await setOverride(scheme.id, field, value, { reason, editedBy: req.user.id });
  }

  res.redirect(`/ops/schemes/${scheme.id}?saved=1`);
});

router.post('/schemes/:id/revert', async (req, res, next) => {
  const scheme = await getScheme(req.params.id);
  if (!scheme) return next();

  const reason = String(req.body.reason || 'Reverted to the scraped value').trim();
  for (const field of Object.keys(scheme.corrections)) {
    await clearOverride(scheme.id, field, { reason, editedBy: req.user.id });
  }
  res.redirect(`/ops/schemes/${scheme.id}?saved=1`);
});

// ------------------------------------------------------------- export ------

/**
 * The whole scraped record, in one place.
 *
 * Everything the crawler collected, including what it could not read and what
 * has since disappeared from its source. The browsing pages deliberately hide
 * retired schemes and never show extraction internals; this does the opposite,
 * because the point is to inspect the collection rather than to shop in it.
 *
 * Behind the ops guard: the schemes themselves are public government
 * information, but the export also carries confidence scores, adapter names,
 * warnings and run ids, which describe how well we are doing rather than what
 * a student is entitled to.
 */

/** One flat row per scheme, for a spreadsheet. */
const CSV_COLUMNS = [
  ['id', (s) => s.id],
  ['name', (s) => s.name],
  ['level', (s) => s.level],
  ['state', (s) => s.state],
  ['ministry', (s) => s.ministry],
  ['tier', (s) => s.detailLevel],
  ['status', (s) => (s.retiredAt ? 'retired' : 'live')],
  ['benefit', (s) => s.benefitText],
  ['deadline', (s) => s.deadline],
  ['max_family_income', (s) => s.eligibility?.maxFamilyIncome ?? ''],
  ['categories', (s) => (s.eligibility?.categories ?? []).join(' | ')],
  ['course_levels', (s) => (s.eligibility?.courseLevels ?? []).join(' | ')],
  ['gender', (s) => (s.eligibility?.gender ?? []).join(' | ')],
  ['disability_required', (s) => (s.eligibility?.disabilityRequired ? 'yes' : '')],
  ['min_marks_percent', (s) => s.eligibility?.minMarksPercent ?? ''],
  ['documents', (s) => (s.documents ?? []).join(' | ')],
  ['confidence', (s) => s.confidence ?? ''],
  ['last_verified', (s) => s.lastVerified],
  ['source_domain', (s) => s.source?.domain ?? ''],
  ['source_url', (s) => s.source?.url ?? ''],
  ['apply_url', (s) => s.applyUrl],
  ['corrected_fields', (s) => Object.keys(s.corrections ?? {}).join(' | ')],
];

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportPayload(includeRetired) {
  const [schemes, meta, sources] = await Promise.all([
    allSchemesForExport({ includeRetired }),
    catalogMeta(),
    listSources(),
  ]);
  return { schemes, meta, sources };
}

router.get('/export.json', async (req, res) => {
  const includeRetired = req.query.retired !== 'false';
  const { schemes, meta, sources } = await exportPayload(includeRetired);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="schemeconnect-catalogue.json"');
  res.send(JSON.stringify({
    exportedAt: new Date().toISOString(),
    generatedBy: 'schemeconnect-scraper',
    policy: ALLOWLIST_DESCRIPTION,
    counts: {
      exported: schemes.length,
      live: schemes.filter((s) => !s.retiredAt).length,
      retired: schemes.filter((s) => s.retiredAt).length,
      withCriteria: schemes.filter((s) => s.detailLevel === 'full').length,
      listingOnly: schemes.filter((s) => s.detailLevel === 'listing').length,
    },
    lastScrapeRun: meta.lastRun ?? null,
    sources: sources.map((s) => ({
      id: s.id, url: s.url, domain: s.domain, adapter: s.adapter,
      level: s.level, state: s.state, enabled: s.enabled,
      lastStatus: s.last_status, lastError: s.last_error, note: s.note,
    })),
    schemes,
  }, null, 2));
});

router.get('/export.csv', async (req, res) => {
  const includeRetired = req.query.retired !== 'false';
  const { schemes } = await exportPayload(includeRetired);

  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const scheme of schemes) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(scheme))).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="schemeconnect-catalogue.csv"');
  // A BOM so Excel opens the scheme names as UTF-8 rather than mojibake.
  res.send('﻿' + lines.join('\n'));
});

router.get('/export', async (req, res) => {
  const { schemes, meta } = await exportPayload(true);
  const live = schemes.filter((s) => !s.retiredAt);
  const withCriteria = schemes.filter((s) => s.detailLevel === 'full');

  const preview = JSON.stringify(withCriteria[0] ?? schemes[0] ?? {}, null, 2);

  res.send(layout({
    title: 'Export the catalogue',
    body: html`
      <div class="app-shell">
        ${raw(opsNav('export'))}
        <main class="main-area">
          <div class="greeting">Export</div>
          <div class="greeting-sub">
            Everything the scraper has collected, including schemes whose criteria it could not read
            and schemes that have since disappeared from their source. This is the collection record,
            not the student-facing catalogue — those pages hide retired entries and extraction internals.
          </div>

          <div class="stat-row">
            <div class="stat-card"><div class="stat-num">${schemes.length}</div><div class="stat-label">Total collected</div></div>
            <div class="stat-card"><div class="stat-num">${live.length}</div><div class="stat-label">Still live</div></div>
            <div class="stat-card"><div class="stat-num">${withCriteria.length}</div><div class="stat-label">Criteria read</div></div>
            <div class="stat-card"><div class="stat-num">${schemes.length - live.length}</div><div class="stat-label">Retired</div></div>
          </div>

          <div class="section-label">Download</div>
          <div class="cta-row">
            <a class="btn-primary btn-inline" href="/ops/export.json">Full JSON ↓</a>
            <a class="btn-outline-sm" style="padding:14px 20px" href="/ops/export.csv">Spreadsheet CSV ↓</a>
            <a class="btn-outline-sm" style="padding:14px 20px" href="/ops/export.json?retired=false">Live schemes only ↓</a>
          </div>
          <p class="foot-note">
            The JSON carries every field, including the sentence each criterion was read from and the
            government URL it came from. The CSV flattens one row per scheme for a spreadsheet.
            Add <span class="mono">?retired=false</span> to either to omit retired entries.
          </p>

          ${raw(meta.lastRun ? html`
            <div class="section-label">Last scrape run</div>
            <div class="info-card">
              <div class="info-row"><span class="k">Started</span><span class="v">${formatDate(meta.lastRun.startedAt)}</span></div>
              <div class="info-row"><span class="k">Schemes kept</span><span class="v">${meta.lastRun.schemesKept ?? '—'}</span></div>
              <div class="info-row"><span class="k">Rejected</span><span class="v">${meta.lastRun.rejections?.length ?? 0}</span></div>
              <div class="info-row"><span class="k">Full detail</span>
                <span class="v"><a href="/ops/runs">See the run history</a></span></div>
            </div>` : '')}

          <div class="section-label">What one record looks like</div>
          <div class="table-wrap">
            <pre class="mono" style="margin:0;padding:16px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-x:auto">${preview}</pre>
          </div>
        </main>
      </div>`,
  }));
});
