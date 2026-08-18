/**
 * Student flows: guided eligibility form, matched results, scheme detail with
 * reason codes, profile, and optional document verification.
 *
 * The guided form follows the PRD's six questions, one per screen, with a
 * progress indicator and save-on-each-step so a dropped connection does not
 * lose progress.
 */

import express from 'express';
import {
  html, raw, layout, studentNav, logoMark, schemeCard, criteriaList, statedCriteria,
  notice, emptyState, catalogBanner, freshnessLabel, formatDate,
} from '../render.js';
import { allSchemes, matchableSchemes, getScheme, catalogMeta, catalogAgeDays } from '../catalog.js';
import {
  matchProfile, evaluateScheme, profileCompleteness, daysUntil,
  INCOME_OPTIONS, CATEGORY_OPTIONS, GENDER_OPTIONS, COURSE_OPTIONS,
} from '../matcher.js';
import { STATES } from '../../scraper/lib/extract.js';
import * as store from '../store.js';

export const router = express.Router();

/**
 * This router sits at the root (its paths are top-level), so the guard is
 * scoped to the paths it owns rather than applied to every request that
 * reaches it — otherwise it would intercept /ops, static files and 404s.
 *
 * /schemes/:id is deliberately absent: scheme detail is readable without an
 * account, per the PRD's progressive-profiling principle.
 */
const STUDENT_ONLY = ['/onboarding', '/dashboard', '/saved', '/applied', '/profile', '/verify-documents'];

function requireStudent(req, res, next) {
  if (!req.user) return res.redirect('/start');
  if (req.user.role !== 'student') return res.redirect('/institute');
  next();
}
router.use(STUDENT_ONLY, requireStudent);

// ------------------------------------------------- guided eligibility form --

const STEPS = [
  {
    key: 'state', label: 'Which state do you live in?',
    hint: 'Scheme eligibility often depends on your state of domicile.',
    field: (v) => html`
      <select name="state" required>
        <option value="">Select your state</option>
        ${raw(STATES.map((s) => `<option ${v === s ? 'selected' : ''}>${s}</option>`).join(''))}
      </select>`,
  },
  {
    key: 'courseLevel', label: 'What are you studying right now?',
    hint: 'Pick the closest match to your current class or course.',
    field: (v) => html`
      <div class="radio-row">
        ${raw(COURSE_OPTIONS.map((c) => `
          <label class="radio-chip"><input type="radio" name="courseLevel" value="${c}" ${v === c ? 'checked' : ''} required><span>${c}</span></label>`).join(''))}
      </div>`,
  },
  {
    key: 'category', label: 'Which category do you belong to?',
    hint: 'Many scholarships are reserved for specific categories. We only use this to match you.',
    field: (v) => html`
      <div class="radio-row">
        ${raw(CATEGORY_OPTIONS.map((c) => `
          <label class="radio-chip"><input type="radio" name="category" value="${c}" ${v === c ? 'checked' : ''} required><span>${c}</span></label>`).join(''))}
      </div>`,
  },
  {
    key: 'income', label: 'What is your annual family income?',
    hint: 'Most scholarships have an income ceiling. A band is enough — we never ask for proof at this stage.',
    field: (v) => html`
      <div class="radio-row">
        ${raw(INCOME_OPTIONS.map((o) => `
          <label class="radio-chip"><input type="radio" name="income" value="${o.value}" ${v === o.value ? 'checked' : ''} required><span>${o.label}</span></label>`).join(''))}
      </div>`,
  },
  {
    key: 'gender', label: 'What is your gender?',
    hint: 'Some scholarships are reserved for girl students. You can skip this.',
    field: (v) => html`
      <div class="radio-row">
        ${raw(GENDER_OPTIONS.map((g) => `
          <label class="radio-chip"><input type="radio" name="gender" value="${g}" ${v === g ? 'checked' : ''}><span>${g}</span></label>`).join(''))}
      </div>`,
  },
  {
    key: 'disability', label: 'Are you a student with a disability?',
    hint: 'Some schemes are specifically for students with disabilities.',
    field: (v) => html`
      <div class="radio-row">
        <label class="radio-chip"><input type="radio" name="disability" value="yes" ${v === true ? 'checked' : ''}><span>Yes</span></label>
        <label class="radio-chip"><input type="radio" name="disability" value="no" ${v === false ? 'checked' : ''}><span>No</span></label>
        <label class="radio-chip"><input type="radio" name="disability" value="skip" ${v === undefined || v === null ? 'checked' : ''}><span>Prefer not to say</span></label>
      </div>`,
  },
];

router.get('/onboarding', async (req, res) => {
  const stepIndex = Math.max(0, Math.min(STEPS.length - 1, Number(req.query.step ?? 0)));
  const step = STEPS[stepIndex];
  const profile = await store.getProfile(req.user.id);

  res.send(layout({
    title: 'A few quick questions',
    body: html`
      <div class="center-wrap">
        <div class="auth-card wide-card">
          <div class="step-track">
            ${raw(STEPS.map((_, i) =>
              `<span class="${i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}"></span>`).join(''))}
          </div>
          <div class="step-count">Question ${stepIndex + 1} of ${STEPS.length}</div>
          <h1 class="headline">${step.label}</h1>
          <p class="subtext">${step.hint}</p>

          <form method="post" action="/onboarding">
            <input type="hidden" name="step" value="${stepIndex}">
            <div class="field">${raw(step.field(profile[step.key]))}</div>
            <button class="btn-primary" type="submit">
              ${stepIndex === STEPS.length - 1 ? 'See my matches' : 'Continue'}
            </button>
          </form>

          ${raw(stepIndex > 0
            ? html`<a class="btn-ghost" href="/onboarding?step=${stepIndex - 1}">Back</a>`
            : '')}
          ${raw(stepIndex >= 2
            ? html`<p class="foot-note"><a href="/dashboard">Skip the rest and see what I have so far</a></p>`
            : html`<p class="foot-note">Your answers are self-reported and used only for matching.
                <a href="/terms" target="_blank" rel="noopener">How we use them</a></p>`)}
        </div>
      </div>`,
  }));
});

router.post('/onboarding', async (req, res) => {
  const stepIndex = Math.max(0, Math.min(STEPS.length - 1, Number(req.body.step ?? 0)));
  const step = STEPS[stepIndex];
  const value = req.body[step.key];

  const patch = {};
  if (step.key === 'disability') {
    patch.disability = value === 'yes' ? true : value === 'no' ? false : null;
  } else if (value !== undefined && value !== '') {
    patch[step.key] = value;
  }
  // Saved on every step, so a dropped connection resumes where it stopped.
  await store.saveProfile(req.user.id, patch);

  if (stepIndex === STEPS.length - 1) return res.redirect('/dashboard');
  res.redirect(`/onboarding?step=${stepIndex + 1}`);
});

// ----------------------------------------------------------- dashboard -----

router.get('/dashboard', async (req, res) => {
  const profile = await store.getProfile(req.user.id);
  const completeness = profileCompleteness(profile);
  const meta = await catalogMeta();
  const ageDays = await catalogAgeDays();
  const schemes = await matchableSchemes();
  const { matches, nearMisses } = matchProfile(schemes, profile);
  const saved = await store.getSaved(req.user.id);

  const firstName = (req.user.name || 'there').split(' ')[0];

  res.send(layout({
    title: 'Your matches',
    body: html`
      <div class="app-shell">
        ${raw(studentNav('home'))}
        <main class="main-area">
          <div class="greeting">Hi ${firstName} 👋</div>
          <div class="greeting-sub">Here's what you may qualify for, based on what you've told us.</div>

          ${raw(catalogBanner(meta, ageDays))}

          <form class="search-bar" method="get" action="/schemes">
            <span class="ic">🔍</span>
            <input name="q" placeholder="Search all ${meta.total} schemes — e.g. 'SC scholarship' or 'post matric'">
            <button type="submit">Search</button>
          </form>

          ${raw(completeness.missing.length ? html`
            <a class="progress-banner" href="/onboarding?step=0">
              <div class="pb-text">
                <b>${completeness.missing.length} question${completeness.missing.length === 1 ? '' : 's'} left</b>
                — still missing ${completeness.missing.map((m) => m.label.toLowerCase()).join(', ')}.
                <div class="bar-track"><div class="bar-fill" style="width:${completeness.percent}%"></div></div>
              </div>
              <span class="pb-btn">Complete profile</span>
            </a>` : '')}

          <div class="section-label">
            ${matches.length} match${matches.length === 1 ? '' : 'es'} from ${schemes.length} assessable schemes
          </div>

          ${raw(matches.length
            ? matches.map((m) => schemeCard(m.scheme, m)).join('')
            : emptyState('🔍', 'No matches yet',
                completeness.missing.length
                  ? 'Answer the remaining questions and we can assess more schemes for you.'
                  : `Your profile did not meet the stated criteria of any of the ${schemes.length} schemes we can currently assess. That is not the same as being ineligible everywhere — our catalogue is partial. Browse <a href="/schemes">all schemes</a> and check the National Scholarship Portal directly.`))}

          ${raw(nearMisses.length ? html`
            <div class="section-label">So close — blocked by one criterion</div>
            <p class="greeting-sub" style="margin-bottom:14px">
              These schemes matched everything except one thing. We show you what, so an absence is never unexplained.</p>
            ${raw(nearMisses.slice(0, 6).map((m) => html`
              <a class="scheme-card" href="/schemes/${m.scheme.id}">
                <div class="sc-top">
                  <div class="sc-name">${m.scheme.name}</div>
                  ${raw(m.scheme.benefitText ? html`<div class="sc-amount">${m.scheme.benefitText}</div>` : '')}
                </div>
                <div class="sc-tags"><span class="tag tag-danger">Blocked by ${m.blockedBy.label.toLowerCase()}</span></div>
                <div class="sc-why">${m.blockedBy.detail}</div>
              </a>`).join(''))}` : '')}

          <p class="foot-note" style="margin-top:30px">
            ${meta.listingOnly} more schemes are in the catalogue but have no machine-readable criteria yet —
            we can name and link them, not assess them. <a href="/schemes">Browse everything</a>.
          </p>
        </main>
      </div>`,
  }));
});

// -------------------------------------------------------- scheme detail ----

router.get('/schemes/:id', async (req, res, next) => {
  const scheme = await getScheme(req.params.id);
  if (!scheme) return next();

  // Readable signed out — an anonymous visitor sees the scheme and its source,
  // just not a personalised assessment.
  const isStudent = Boolean(req.user && req.user.role === 'student');
  const profile = isStudent ? await store.getProfile(req.user.id) : {};
  const saved = isStudent ? await store.getSaved(req.user.id) : [];
  const applied = isStudent ? await store.getApplied(req.user.id) : [];
  const isSaved = saved.includes(scheme.id);
  const isApplied = applied.some((a) => a.schemeId === scheme.id);
  const evaluation = isStudent && scheme.detailLevel === 'full' ? evaluateScheme(scheme, profile) : null;
  const days = daysUntil(scheme.deadline);

  res.send(layout({
    title: scheme.name,
    body: html`
      <div class="app-shell">
        ${raw(isStudent ? studentNav('home') : html`
          <nav class="side-nav">
            ${raw(logoMark('/'))}
            <a class="nav-item" href="/schemes"><span class="ic"></span>All schemes</a>
            <a class="nav-item" href="/start"><span class="ic"></span>Log in</a>
            <div class="nav-spacer"></div>
            <a class="nav-item" href="/terms"><span class="ic"></span>Terms</a>
          </nav>`)}
        <main class="main-area narrow">
          <a class="link-back" href="${isStudent ? '/dashboard' : '/schemes'}">← Back to ${isStudent ? 'matches' : 'all schemes'}</a>

          <div class="detail-hero">
            <div class="detail-ministry">
              ${scheme.ministry || (scheme.level === 'central' ? 'Central government scheme' : `${scheme.state} state scheme`)}
            </div>
            <div class="detail-title">${scheme.name}</div>
            <div class="detail-meta">
              <span class="tag tag-verified">✓ ${freshnessLabel(scheme.lastVerified)}</span>
              ${raw(scheme.deadline
                ? html`<span class="tag ${days < 0 ? 'tag-danger' : 'tag-deadline'}">
                    ${days < 0 ? `Closed ${formatDate(scheme.deadline)}` : `Closes in ${days} days · ${formatDate(scheme.deadline)}`}</span>`
                : html`<span class="tag tag-locked">No deadline found in source</span>`)}
            </div>
            ${raw(scheme.benefitText ? html`<div class="detail-amount">${scheme.benefitText}</div>` : '')}
            ${raw(scheme.summary ? html`<div style="font-size:14px; color:var(--muted); line-height:1.65; margin-top:8px">${scheme.summary}</div>` : '')}
          </div>

          ${raw(scheme.detailLevel === 'listing' ? notice('warn', html`
            <b>We have not read this scheme's eligibility rules.</b> It appears on an official government listing,
            so the name and link are genuine, but our scraper could not extract its criteria — often because they
            live in a scanned PDF or on a page we cannot reach. Open the official page to check whether you qualify.`) : '')}

          ${raw(!isStudent && scheme.detailLevel === 'full' ? notice('info', html`
            <b>Log in to check whether you qualify.</b> We'll compare this scheme's criteria against your
            answers and show you exactly which ones you meet. <a href="/start">Takes under three minutes</a>.`) : '')}

          ${raw(evaluation ? html`
            <div class="info-card">
              <h3>${evaluation.matched ? 'Why you matched' : 'How you compare'}</h3>
              ${raw(criteriaList(evaluation))}
              ${raw(evaluation.unknown.length ? html`
                <div class="notice notice-info" style="margin:14px 0 0">
                  A “?” means the scheme states this criterion but we could not confirm it from your profile, or
                  could not read it reliably from the source. We never treat an unknown as a pass.
                </div>` : '')}
            </div>`
            : (statedCriteria(scheme) ? html`
            <div class="info-card">
              <h3>What this scheme requires</h3>
              ${raw(statedCriteria(scheme))}
              <div class="hint" style="margin-top:12px;font-size:12px;color:var(--muted)">
                Read automatically from the government source shown below. Each line quotes the sentence it came
                from, so you can check our reading against the original.
              </div>
            </div>` : ''))}

          ${raw(scheme.documents?.length ? html`
            <div class="info-card">
              <h3>Documents you'll likely need</h3>
              <ul class="doc-list">
                ${raw(scheme.documents.map((d) => `<li><input type="checkbox"> ${d}</li>`).join(''))}
              </ul>
              <div class="hint" style="font-size:12px;color:var(--muted)">
                Extracted from the scheme's own text. The official page is authoritative — confirm there before applying.
              </div>
            </div>` : '')}

          <div class="info-card">
            <h3>Where this came from</h3>
            <div class="info-row"><span class="k">Source</span>
              <span class="v"><a href="${scheme.source.url}" target="_blank" rel="noopener noreferrer">${scheme.source.domain}</a></span></div>
            <div class="info-row"><span class="k">Document type</span><span class="v">${scheme.source.docType}</span></div>
            <div class="info-row"><span class="k">Collected by</span><span class="v mono">${scheme.source.adapter}</span></div>
            <div class="info-row"><span class="k">Last verified</span><span class="v">${formatDate(scheme.lastVerified)}</span></div>
            <div class="info-row"><span class="k">Extraction confidence</span>
              <span class="v">${Math.round((scheme.confidence ?? 0) * 100)}%</span></div>
          </div>

          <div class="cta-row">
            <a class="btn-primary btn-inline" href="${scheme.applyUrl}" target="_blank" rel="noopener noreferrer"
               data-mark-applied="${isStudent ? scheme.id : ''}">
              Continue to official application ↗</a>
            ${raw(isStudent ? html`
              <form method="post" action="/saved/${scheme.id}">
                <button class="btn-outline-sm" style="padding:14px 20px" type="submit">
                  ${isSaved ? '★ Saved' : '☆ Save this scheme'}</button>
              </form>` : html`
              <a class="btn-outline-sm" style="padding:14px 20px" href="/start">☆ Log in to save</a>`)}
          </div>
          <div class="apply-note">
            You'll complete and submit your application on the official government portal.
            ${raw(isApplied ? '<br>You marked this as applied.' : '')}
          </div>
        </main>
      </div>`,
  }));
});

// -------------------------------------------------------- saved / applied --

router.post('/saved/:id', async (req, res) => {
  await store.toggleSaved(req.user.id, req.params.id);
  res.redirect(req.get('referer') || '/saved');
});

router.post('/applied/:id', async (req, res) => {
  await store.markApplied(req.user.id, req.params.id);
  res.status(204).end();
});

router.get('/saved', async (req, res) => {
  const ids = await store.getSaved(req.user.id);
  const all = await allSchemes();
  const schemes = all.filter((s) => ids.includes(s.id));

  res.send(layout({
    title: 'Saved schemes',
    body: html`
      <div class="app-shell">
        ${raw(studentNav('saved'))}
        <main class="main-area">
          <div class="greeting">Saved</div>
          <div class="greeting-sub">Schemes you've kept to come back to.</div>
          ${raw(schemes.length
            ? schemes.map((s) => schemeCard(s)).join('')
            : emptyState('☆', 'Nothing saved yet',
                'Open a scheme and tap “Save this scheme” to keep it here.'))}
        </main>
      </div>`,
  }));
});

router.get('/applied', async (req, res) => {
  const applied = await store.getApplied(req.user.id);
  const all = await allSchemes();

  res.send(layout({
    title: 'Applied',
    body: html`
      <div class="app-shell">
        ${raw(studentNav('applied'))}
        <main class="main-area">
          <div class="greeting">Applied</div>
          <div class="greeting-sub">
            Schemes you told us you applied for. We cannot see your application status — that lives on the
            government portal you applied through.
          </div>
          ${raw(applied.length ? html`
            <div class="table-wrap">
              <table>
                <tr><th>Scheme</th><th>Marked on</th><th>Status</th></tr>
                ${raw(applied.map((a) => {
                  const s = all.find((x) => x.id === a.schemeId);
                  return html`<tr>
                    <td class="b">${s ? s.name : a.schemeId}</td>
                    <td>${formatDate(a.markedAt)}</td>
                    <td><span class="pill pill-pending">On government portal</span></td>
                  </tr>`;
                }).join(''))}
              </table>
            </div>` : emptyState('📄', 'Nothing marked as applied',
                'When you open a scheme\'s official application page, we mark it here so you can keep track.'))}
        </main>
      </div>`,
  }));
});

// ------------------------------------------------------------- profile -----

router.get('/profile', async (req, res) => {
  const profile = await store.getProfile(req.user.id);
  const consent = await store.getConsent(req.user.id);
  const completeness = profileCompleteness(profile);
  const initials = (req.user.name || 'S').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const incomeLabel = INCOME_OPTIONS.find((o) => o.value === profile.income)?.label;

  const row = (k, v) => html`<div class="info-row"><span class="k">${k}</span><span class="v">${v || '—'}</span></div>`;

  res.send(layout({
    title: 'My profile',
    body: html`
      <div class="app-shell">
        ${raw(studentNav('profile'))}
        <main class="main-area narrow">
          <div class="profile-header">
            <div class="avatar">${initials}</div>
            <div>
              <div class="greeting" style="font-size:20px; margin-bottom:2px;">${req.user.name}</div>
              <div class="greeting-sub" style="margin-bottom:0;">Member since ${formatDate(req.user.createdAt)}</div>
            </div>
          </div>

          <div class="verify-card">
            <div>
              <div class="vt">Verify your profile</div>
              <div class="vs">Confirm your ID, income and education to unlock higher-accuracy matches and a
                verified badge. Optional, do it anytime.</div>
            </div>
            <a class="vbtn" href="/verify-documents">Verify now</a>
          </div>

          <div class="info-card">
            <h3>Contact details</h3>
            ${raw(row('Mobile / login', html`${req.user.identifier} <span class="tag tag-verified" style="padding:3px 8px;">✓ Verified</span>`))}
            ${raw(row('Email', req.user.email))}
          </div>

          <div class="info-card">
            <h3>Eligibility details <span class="tag tag-self">Self-reported</span></h3>
            ${raw(row('State', profile.state))}
            ${raw(row('Class / course', profile.courseLevel))}
            ${raw(row('Category', profile.category))}
            ${raw(row('Annual family income', incomeLabel))}
            ${raw(row('Gender', profile.gender))}
            ${raw(row('Disability', profile.disability === true ? 'Yes' : profile.disability === false ? 'No' : 'Not answered'))}
            <div class="hint" style="margin-top:12px;font-size:12px;color:var(--muted)">
              ${completeness.filled} of ${completeness.total} answered.
            </div>
          </div>

          <div class="info-card">
            <h3>Consent record</h3>
            ${raw(row('Terms version accepted', consent?.termsVersion))}
            ${raw(row('Accepted on', formatDate(consent?.acceptedAt)))}
            ${raw(row('Declared under 18', consent?.isMinor ? 'Yes' : 'No'))}
            ${raw(consent?.isMinor ? row('Guardian', `${consent.guardianName} · ${consent.guardianContact}`) : '')}
            <div class="hint" style="margin-top:12px;font-size:12px;color:var(--muted)">
              Kept as your DPDP Act consent record. <a href="/terms#t4">What this means</a>
            </div>
          </div>

          <a class="btn-ghost" href="/onboarding?step=0">Edit my details</a>
          <form method="post" action="/profile/delete"
                onsubmit="return confirm('This permanently deletes your profile, saved schemes and consent record. Continue?')">
            <button class="btn-ghost" type="submit" style="color:var(--danger);border-color:#F5C2C2">Delete my account and data</button>
          </form>
        </main>
      </div>`,
  }));
});

router.post('/profile/delete', async (req, res) => {
  await store.deleteUser(req.user.id);
  if (req.cookies?.sc_session) await store.destroySession(req.cookies.sc_session);
  res.clearCookie('sc_session');
  res.redirect('/?deleted=1');
});

// ------------------------------------------------- document verification ---

const DOCS = [
  { key: 'identity', icon: '🪪', title: 'Identity — Aadhaar / DigiLocker', sub: 'Confirms your date of birth and address' },
  { key: 'income', icon: '💳', title: 'Income — Income certificate / PAN', sub: 'Confirms your family income bracket' },
  { key: 'education', icon: '🎓', title: 'Education — Marksheet', sub: 'Confirms your current education level' },
];

router.get('/verify-documents', async (req, res) => {
  const verified = req.user.documentsVerified || {};

  res.send(layout({
    title: 'Verify your profile',
    body: html`
      <div class="app-shell">
        ${raw(studentNav('profile'))}
        <main class="main-area narrow">
          <a class="link-back" href="/profile">← Back to profile</a>
          <div class="greeting" style="font-size:22px;">Verify your profile</div>
          <div class="greeting-sub">
            Completely optional. Verifying improves match accuracy — you can keep browsing without it.
            Documents are never shared without your consent.
          </div>

          ${raw(DOCS.map((d) => html`
            <div class="verify-item">
              <div class="vi-left">
                <div class="vi-icon">${d.icon}</div>
                <div><div class="vi-title">${d.title}</div><div class="vi-sub">${d.sub}</div></div>
              </div>
              ${raw(verified[d.key]
                ? html`<span class="btn-outline-sm"><span class="status-dot done"></span>Verified</span>`
                : html`<a class="btn-outline-sm" href="/verify-documents/${d.key}"><span class="status-dot pending"></span>Verify</a>`)}
            </div>`).join(''))}

          ${raw(notice('info', html`
            Verification is used only to raise your match accuracy. It is never required to search or view schemes,
            and you can delete an uploaded document at any time.`))}
        </main>
      </div>`,
  }));
});

router.get('/verify-documents/:type', async (req, res, next) => {
  const doc = DOCS.find((d) => d.key === req.params.type);
  if (!doc) return next();

  res.send(layout({
    title: `Upload — ${doc.title}`,
    body: html`
      <div class="center-wrap">
        <div class="auth-card wide-card">
          <a class="link-back" href="/verify-documents">← Back to verification</a>
          <div class="eyebrow">${doc.title}</div>
          <h1 class="headline">Upload your document</h1>
          <p class="subtext">A clear photo or scan is fine. We only use this to confirm your details.</p>

          <form method="post" action="/verify-documents/${doc.key}" id="docForm">
            <div class="dropzone" id="docDropzone">
              <div class="dz-icon">📄</div>
              <div class="dz-title">Click to choose a file</div>
              <div class="dz-sub">JPG, PNG or PDF · up to 10 MB</div>
            </div>
            <input type="file" id="docFileInput" accept="image/*,application/pdf" hidden>
            <div id="docChosen" hidden>
              <div class="file-chip">
                <div class="fc-left"><div class="fc-icon">📄</div><span id="docFileName"></span></div>
                <span class="fc-remove" id="docRemove">Remove</span>
              </div>
            </div>
            ${raw(notice('info', html`
              <b>Pilot build:</b> the file is not uploaded or stored anywhere. This records the verification
              state only, so the flow can be reviewed end to end. Real document handling needs encrypted storage
              and a retention policy before any pilot with real students.`))}
            <button class="btn-primary" type="submit" id="docSubmit" disabled>Confirm &amp; verify</button>
          </form>
        </div>
      </div>`,
  }));
});

router.post('/verify-documents/:type', async (req, res) => {
  const doc = DOCS.find((d) => d.key === req.params.type);
  if (doc) {
    const verified = { ...(req.user.documentsVerified || {}), [doc.key]: new Date().toISOString() };
    await store.updateUser(req.user.id, { documentsVerified: verified });
  }
  res.redirect('/verify-documents');
});
