/**
 * Public routes: landing page, Terms & Conditions, and the open scheme
 * catalogue. Everything here works without an account, matching the PRD's
 * progressive-profiling principle — browse first, sign up only to save.
 */

import express from 'express';
import {
  html, raw, layout, logoMark, schemeCard, notice, emptyState, catalogBanner, studentNav,
} from '../render.js';
import { matchableSchemes, searchSchemes, catalogMeta, catalogAgeDays } from '../catalog.js';
import { TERMS_SECTIONS, TERMS_UPDATED, TERMS_VERSION } from '../terms.js';

export const router = express.Router();

// ------------------------------------------------------------- landing -----

router.get('/', async (req, res) => {
  const meta = await catalogMeta();
  const teasers = (await matchableSchemes()).slice(0, 3);
  const fallback = teasers.length ? teasers : (await searchSchemes({ limit: 3 })).schemes;

  res.send(layout({
    title: 'Find every scholarship you qualify for',
    body: html`
      <div class="landing-header">
        ${raw(logoMark())}
        <a href="/start" class="landing-login-link">Log in</a>
      </div>

      <div class="landing-hero">
        <h1>Find every scholarship you actually qualify for.</h1>
        <p>One place to check your eligibility across ${meta.total || 'government'} central and state government
           schemes — each one linked to its official source and stamped with the date we last verified it.</p>
        <a class="landing-cta" href="/start">Get started — it's free</a>
        <div class="landing-subcta">No password needed. Takes under three minutes.</div>
      </div>

      <div class="teaser-wrap">
        ${raw(!meta.exists || meta.total === 0
          ? notice('warn', html`
              <b>The catalogue is empty.</b> Every scheme on this site comes from the bundled government scraper,
              which has not been run yet. Run <span class="mono">npm run scrape</span> to populate it.`)
          : html`
            <div class="teaser-label">A few schemes students are matching with</div>
            <div class="teaser-grid">
              ${raw(fallback.map((s) => html`
                <div class="teaser-card">
                  <div class="sc-name">${s.name}</div>
                  ${raw(s.benefitText ? html`<span class="sc-amount">${s.benefitText}</span>` : '<span class="sc-amount">See official page</span>')}
                  <div class="teaser-lock">🔒 Log in to see if you qualify</div>
                </div>`).join(''))}
            </div>
            <p class="foot-note" style="margin-top:26px">
              ${meta.total} schemes collected from ${meta.sources.length} government
              ${meta.sources.length === 1 ? 'domain' : 'domains'} ·
              ${meta.matchable} with machine-readable eligibility criteria ·
              <a href="/ops">catalogue health</a>
            </p>`)}
      </div>`,
  }));
});

// --------------------------------------------------------------- terms -----

router.get('/terms', (req, res) => {
  res.send(layout({
    title: 'Terms & Conditions',
    body: html`
      <div class="terms-page">
        <a class="link-back" href="javascript:history.length>1?history.back():location.href='/'">← Back</a>

        <div class="terms-head">
          ${raw(logoMark())}
          <h1>Terms &amp; Conditions</h1>
          <div class="terms-updated">Version ${TERMS_VERSION} · Last updated ${TERMS_UPDATED} · Public beta ·
            Applies to students, parents and institutes</div>
          <p class="terms-intro">SchemeConnect is a discovery and trust layer for government scholarships and schemes.
            We help you find schemes you may qualify for, show you where each one came from and when it was last
            verified, and tell you what documents you'll need. We are not a government body, and we do not receive,
            process, approve or disburse any application or payment. By creating an account you agree to the terms below.</p>
          <div class="terms-callout"><b>The short version:</b> we tell you what you may qualify for and send you to the
            official government portal to apply. A match is not an approval. Our catalogue is built by software reading
            government pages, so it can be incomplete or out of date — always confirm on the official page. Checking
            your eligibility is free, and always will be. If you're under 18, a parent or guardian must consent.</div>
        </div>

        <div class="terms-toc">
          <div class="section-label" style="margin:0;">On this page</div>
          <ol>
            ${raw(TERMS_SECTIONS.map((s) => html`<li><a href="#${s.id}">${s.title}</a></li>`).join(''))}
          </ol>
        </div>

        <div class="terms-body">
          ${raw(TERMS_SECTIONS.map((s, i) => `
            <section id="${s.id}">
              <h2>${i + 1}. ${s.title}</h2>
              ${s.body}
            </section>`).join(''))}
        </div>

        <p class="terms-foot">These terms are drafted for a pilot and must be reviewed by legal counsel before launch.<br>
          Questions? <a href="mailto:support@schemeconnect.com">support@schemeconnect.com</a></p>
      </div>`,
  }));
});

// ----------------------------------------------------- public catalogue ----

router.get('/schemes', async (req, res) => {
  const meta = await catalogMeta();
  const ageDays = await catalogAgeDays();
  const q = String(req.query.q || '').trim().toLowerCase();
  const level = String(req.query.level || 'all');

  // Ranked search in SQL. This was a .includes() over every scheme held in
  // memory, which found nothing for a misspelt query and got slower with the
  // catalogue.
  const { schemes: shown, total } = await searchSchemes({ q, level, limit: 200 });
  const loggedIn = Boolean(req.user);

  res.send(layout({
    title: 'All schemes',
    body: html`
      <div class="app-shell">
        ${raw(loggedIn && req.user.role === 'student' ? studentNav('browse') : html`
          <nav class="side-nav">
            ${raw(logoMark())}
            <a class="nav-item active" href="/schemes"><span class="ic"></span>All schemes</a>
            <a class="nav-item" href="/start"><span class="ic"></span>Log in</a>
            <div class="nav-spacer"></div>
            <a class="nav-item" href="/terms"><span class="ic"></span>Terms</a>
          </nav>`)}
        <main class="main-area">
          <div class="greeting">All schemes</div>
          <div class="greeting-sub">
            Every scheme here was collected by our scraper from an official government domain.
            ${meta.matchable} of ${meta.total} have machine-readable eligibility criteria and can be matched to a profile;
            the rest we can name and link, but not yet assess.
          </div>

          ${raw(catalogBanner(meta, ageDays))}

          <form class="search-bar" method="get" action="/schemes">
            <span class="ic">🔍</span>
            <input name="q" value="${q}" placeholder="Search by scheme name or ministry">
            <button type="submit">Search</button>
          </form>

          <div class="sc-tags" style="margin-bottom:20px">
            ${raw(['all', 'matchable', 'central', 'state'].map((l) => html`
              <a class="tag ${level === l ? 'tag-match' : 'tag-locked'}"
                 href="/schemes?level=${l}${q ? `&q=${encodeURIComponent(q)}` : ''}"
                 style="text-decoration:none">${l === 'all' ? 'All' : l === 'matchable' ? 'With criteria' : l === 'central' ? 'Central' : 'State'}</a>`).join(''))}
          </div>

          <div class="section-label">${total} scheme${total === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''}</div>

          ${raw(shown.length
            ? shown.map((s) => schemeCard(s)).join('')
            : emptyState('🔍', 'Nothing found',
                'No scheme in the catalogue matches that search. Try a broader term, or check the National Scholarship Portal directly.'))}

          ${raw(total > shown.length
            ? html`<p class="foot-note">Showing the first ${shown.length} of ${total}. Narrow your search to see more.</p>`
            : '')}
        </main>
      </div>`,
  }));
});
