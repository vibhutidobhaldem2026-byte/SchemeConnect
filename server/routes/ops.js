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
import { allSchemes, catalogMeta, catalogAgeDays } from '../catalog.js';
import { SOURCES } from '../../config/sources.js';
import { ALLOWLIST_DESCRIPTION } from '../../scraper/lib/allowlist.js';
import * as store from '../store.js';

export const router = express.Router();

function opsNav(active) {
  const item = (key, label, href) => html`
    <a class="nav-item ${active === key ? 'active' : ''}" href="${href}"><span class="ic"></span>${label}</a>`;
  return html`
    <nav class="side-nav">
      ${raw(logoMark('/'))}
      ${raw(item('catalog', 'Catalogue', '/ops'))}
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
