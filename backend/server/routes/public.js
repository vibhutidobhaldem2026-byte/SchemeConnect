/**
 * Public routes: landing page, Terms & Conditions, and the open scheme
 * catalogue. Everything here works without an account, matching the PRD's
 * progressive-profiling principle — browse first, sign up only to save.
 */

import express from 'express';
import {
  html, raw, layout, logoMark, navIcon, schemeCard, notice, emptyState, catalogBanner, studentNav, publicNav,
  formatDate,
} from '../render.js';
import { matchableSchemes, searchSchemes, catalogMeta, catalogAgeDays } from '../catalog.js';
import { TERMS_SECTIONS, TERMS_UPDATED, TERMS_VERSION } from '../terms.js';

export const router = express.Router();

// ------------------------------------------------------------- landing -----

/**
 * The three steps of the product, stated once so the landing page and any
 * future explainer cannot drift apart.
 */
const HOW_IT_WORKS = [
  {
    title: 'Answer six questions',
    body: `Your state, what you are studying, your category, your family income band, your gender and whether
           you have a disability. One question per screen, saved as you go. No password, no documents, no
           registration number.`,
  },
  {
    title: 'See what you match, and why',
    body: `Every scheme comes back with its eligibility rules laid out one by one — which ones you meet, which
           ones you do not, and which ones we could not read from the government page. Nothing is a black box.`,
  },
  {
    title: 'Apply on the official portal',
    body: `We are not a middleman. When you are ready, we hand you the official government link, the deadline
           and the document checklist, and you apply on the government's own site. We never take a fee.`,
  },
];

const TRUST_POINTS = [
  {
    title: 'Every scheme traced to a government source',
    body: `Nothing here is written by us or bought from an aggregator. Each entry is read by our scraper from a
           page on an official government domain, and every scheme carries a link back to that page so you can
           check it yourself.`,
  },
  {
    title: 'Every criterion quotes its source sentence',
    body: `When we say a scheme has an income ceiling, we show you the sentence on the government page the
           ceiling was read from. If the wording is ambiguous, you can see that for yourself instead of trusting
           our summary.`,
  },
  {
    title: 'What we could not read is never a pass',
    body: `A criterion we failed to parse is shown as unknown, not as a match. We would rather tell you that we
           do not know than send you to an application you were never eligible for.`,
  },
  {
    title: 'Dated, not evergreen',
    body: `Government schemes change without notice. Every scheme shows the date it was last verified, and a
           scheme whose deadline has passed is labelled closed rather than quietly dropped.`,
  },
];

router.get('/', async (req, res) => {
  const meta = await catalogMeta();
  const teasers = (await matchableSchemes()).slice(0, 3);
  const fallback = teasers.length ? teasers : (await searchSchemes({ limit: 3 })).schemes;
  const empty = !meta.exists || meta.total === 0;
  const coverage = meta.coverage ?? null;

  // Every figure on this page is read off the catalogue. If a number is not in
  // the catalogue it does not appear here — the whole pitch is that we do not
  // make claims we cannot show the source for.
  const stats = [
    { num: meta.total, label: 'schemes read from government pages' },
    { num: meta.matchable, label: 'with eligibility rules we can check against a profile' },
    { num: meta.sources.length, label: `official government ${meta.sources.length === 1 ? 'domain' : 'domains'} crawled` },
    { num: meta.withDeadline, label: 'with a confirmed application deadline' },
  ];

  res.send(layout({
    title: 'Government scholarships you actually qualify for',
    bodyClass: 'landing',
    body: html`
      <header class="landing-header">
        ${raw(logoMark())}
        <nav class="landing-nav" aria-label="Site">
          <a href="/schemes">Browse schemes</a>
          <a href="/terms">Terms</a>
          <a href="/start" class="landing-login-link">Log in</a>
        </nav>
      </header>

      <main>
        <section class="landing-hero">
          <p class="landing-eyebrow">For school and college students in India</p>
          <h1>Find the government scholarships you actually qualify for.</h1>
          <p class="landing-lede">
            There are hundreds of central and state scholarships, spread across dozens of government sites, each
            with its own eligibility rules. Answer six questions and SchemeConnect tells you which ones you match
            — and shows you the government sentence behind every rule. Minutes, instead of working through the
            National Scholarship Portal's full registration flow just to find out you were never eligible.
          </p>
          <div class="landing-cta-row">
            <a class="landing-cta" href="/start">Check my eligibility</a>
            <a class="landing-cta-alt" href="/schemes">Browse all schemes</a>
          </div>
          <p class="landing-subcta">
            Free, and always will be. No password — we send a one-time code. You can browse the whole
            catalogue without an account.
          </p>
        </section>

        ${raw(empty ? '' : html`
          <section class="landing-stats" aria-label="Catalogue at a glance">
            ${raw(stats.map((s) => html`
              <div class="lstat">
                <div class="lstat-num">${s.num}</div>
                <div class="lstat-label">${s.label}</div>
              </div>`).join(''))}
          </section>`)}

        <section class="landing-section">
          <h2 class="landing-h2">How it works</h2>
          <p class="landing-sub">Three steps. The third one happens on the government's website, not ours.</p>
          <ol class="how-grid">
            ${raw(HOW_IT_WORKS.map((s, i) => html`
              <li class="how-card">
                <span class="how-num">${i + 1}</span>
                <h3>${s.title}</h3>
                <p>${s.body}</p>
              </li>`).join(''))}
          </ol>
        </section>

        <section class="landing-section landing-section-alt">
          <h2 class="landing-h2">Why you can check our work</h2>
          <p class="landing-sub">
            A scholarship you were never eligible for costs a student a day of paperwork. So the product is built
            to be auditable rather than confident.
          </p>
          <div class="trust-grid">
            ${raw(TRUST_POINTS.map((t) => html`
              <div class="trust-card">
                <h3>${t.title}</h3>
                <p>${t.body}</p>
              </div>`).join(''))}
          </div>
        </section>

        <section class="landing-section">
          ${raw(empty
            ? notice('warn', html`
                <b>The catalogue is empty.</b> Every scheme on this site comes from the bundled government scraper,
                which has not been run yet. Run <span class="mono">npm run scrape</span> to populate it. Nothing on
                this site is hand-authored, so until then there is nothing to show.`)
            : html`
              <h2 class="landing-h2">A few schemes in the catalogue</h2>
              <p class="landing-sub">Open any of them to read the eligibility rules and the source they came from.</p>
              <div class="teaser-grid">
                ${raw(fallback.map((s) => html`
                  <a class="teaser-card" href="/schemes/${s.id}">
                    <div class="sc-name">${s.name}</div>
                    ${raw(s.benefitText
                      ? html`<span class="sc-amount">${s.benefitText}</span>`
                      : '<span class="sc-amount sc-amount-muted">See official page</span>')}
                    <span class="teaser-lock">Read the criteria and their sources →</span>
                  </a>`).join(''))}
              </div>
              <p class="landing-more"><a href="/schemes">See all ${meta.total} schemes</a></p>`)}
        </section>

        <section class="landing-section landing-section-alt">
          <h2 class="landing-h2">What we do not cover yet</h2>
          <p class="landing-sub">
            Being honest about the gaps is the point. This is what the catalogue actually contains today.
          </p>
          <ul class="honesty-list">
            ${raw(coverage ? html`
              <li>
                <b>${coverage.coveredCount} of ${coverage.totalStates} states and union territories</b> have at least
                one state scheme in the catalogue. ${raw(coverage.uncoveredCount > 0
                  ? html`For the other ${coverage.uncoveredCount}, we can only show you central schemes — and we say so
                         in your results rather than pretending there was nothing to find.`
                  : '')}
              </li>` : '')}
            ${raw(meta.listingOnly > 0 ? html`
              <li>
                <b>${meta.listingOnly} of ${meta.total} schemes are listing-only.</b> We have the name and the official
                link, but the page did not state its eligibility rules in a form we could read. Those are shown as
                "criteria not yet read" — never as a match.
              </li>` : '')}
            <li>
              <b>A match is not an approval.</b> We are not a government body. We do not receive, process or approve
              applications, and we cannot promise a scheme is still open or still funded. Always confirm on the
              official page before you rely on it.
            </li>
            <li>
              <b>Your answers are self-reported.</b> The government portal will ask for proof of income, category and
              marks at application time. We match on what you tell us.
            </li>
          </ul>
        </section>

        <section class="landing-final">
          <h2>Six questions. Then you will know.</h2>
          <p>Checking is free, takes a few minutes, and you can stop at any point — we save each answer as you go.</p>
          <a class="landing-cta landing-cta-light" href="/start">Check my eligibility</a>
        </section>
      </main>

      <footer class="landing-footer">
        <div class="lf-inner">
          <div class="lf-brand">
            ${raw(logoMark())}
            <p>A discovery and trust layer for Indian government scholarships. Independent, free, and not affiliated
               with any government department.</p>
          </div>
          <nav class="lf-links" aria-label="Footer">
            <a href="/schemes">All schemes</a>
            <a href="/start">Log in or sign up</a>
            <a href="/terms">Terms &amp; conditions</a>
            <a href="mailto:support@schemeconnect.com">support@schemeconnect.com</a>
          </nav>
        </div>
        ${raw(empty ? '' : html`
          <p class="lf-meta">
            Catalogue last verified ${formatDate(meta.generatedAt) || 'not yet'} ·
            ${meta.central} central and ${meta.state} state schemes from
            ${meta.sources.length} government ${meta.sources.length === 1 ? 'domain' : 'domains'}
          </p>`)}
      </footer>`,
  }));
});

// --------------------------------------------------------------- terms -----

router.get('/terms', (req, res) => {
  res.send(layout({
    title: 'Terms & Conditions',
    body: html`
      <div class="terms-page">
        <a class="link-back" href="/" data-back>← Back</a>

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
        ${raw(loggedIn && req.user.role === 'student' ? studentNav('browse') : publicNav('browse'))}
        <main class="main-area">
          <div class="greeting">All schemes</div>
          <div class="greeting-sub">
            Every scheme here was collected by our scraper from an official government domain.
            ${meta.matchable} of ${meta.total} have machine-readable eligibility criteria and can be matched to a profile;
            the rest we can name and link, but not yet assess.
          </div>

          ${raw(catalogBanner(meta, ageDays))}

          <form class="search-bar" method="get" action="/schemes">
            ${raw(navIcon('browse'))}
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
