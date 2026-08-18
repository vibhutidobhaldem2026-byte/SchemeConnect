/**
 * Authentication: OTP entry, verification, and the sign-up screens that carry
 * the Terms & Conditions gate.
 *
 * The consent gate is enforced server-side. The checkbox in the browser is the
 * affordance; this router is what actually refuses to create an account
 * without a recorded acceptance — including the DPDP Act guardian details when
 * the user tells us they are under 18.
 */

import express from 'express';
import { html, raw, layout, logoMark, notice } from '../render.js';
import * as store from '../store.js';
import { TERMS_VERSION } from '../terms.js';
import { sendOtpEmail, isEmailConfigured, senderAddress } from '../mailer.js';

export const router = express.Router();

const isMobile = (v) => /^[6-9]\d{9}$/.test(String(v).replace(/\D/g, '').slice(-10));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());

/**
 * Students may sign in with a mobile number or an email address.
 *
 * The PRD is mobile-first, but only email can actually be delivered right now
 * (Resend is wired up; no SMS provider is). Accepting either means the flow is
 * genuinely testable end to end instead of depending on a code printed to a
 * console. Institutes remain work-email only.
 */
function normaliseIdentifier(role, rawValue) {
  const value = String(rawValue || '').trim();
  if (role === 'institute') {
    return isEmail(value) ? value.toLowerCase() : null;
  }
  if (isEmail(value)) return value.toLowerCase();
  const digits = value.replace(/\D/g, '').slice(-10);
  return isMobile(digits) ? `+91${digits}` : null;
}

export const identifierIsEmail = (identifier) => String(identifier).includes('@');

/**
 * Issues a code and delivers it.
 *
 * Email goes through Resend. Mobile has no provider, so the code is shown on
 * screen instead — the verify page says which happened rather than implying a
 * message is on its way.
 */
async function issueAndDeliver(identifier, { isInstitute = false } = {}) {
  const code = await store.issueOtp(identifier);

  if (!identifierIsEmail(identifier)) {
    console.log(`\n  [OTP] ${identifier} -> ${code}   (no SMS provider configured — shown on screen)\n`);
    return store.recordOtpDelivery(identifier, {
      channel: 'sms',
      sent: false,
      error: 'No SMS provider is configured.',
    });
  }

  if (!isEmailConfigured()) {
    console.log(`\n  [OTP] ${identifier} -> ${code}   (RESEND_API_KEY not set — shown on screen)\n`);
    return store.recordOtpDelivery(identifier, {
      channel: 'email',
      sent: false,
      error: 'RESEND_API_KEY is not set.',
    });
  }

  const result = await sendOtpEmail(identifier, code, {
    minutes: store.OTP_TTL_MINUTES,
    isInstitute,
  });

  if (result.ok) {
    console.log(`  [OTP] emailed to ${identifier} (resend id ${result.id})`);
  } else {
    // Log the reason but keep the code usable, so a delivery problem doesn't
    // become a dead end while testing.
    console.error(`  [OTP] email to ${identifier} FAILED: ${result.error}`);
    console.log(`  [OTP] ${identifier} -> ${code}   (falling back to on-screen display)`);
  }

  return store.recordOtpDelivery(identifier, {
    channel: 'email',
    sent: result.ok,
    error: result.ok ? null : result.error,
    // Record the address it actually went out from, which may be the fallback
    // sender while a custom domain is still awaiting DNS verification. The
    // verify screen tells the user who to look for, so it must be the real one.
    from: result.from ?? null,
    usedFallback: Boolean(result.usedFallback),
  });
}

// ------------------------------------------------------------- role pick ---

router.get('/start', (req, res) => {
  res.send(layout({
    title: 'Who are you?',
    body: html`
      <div class="center-wrap">
        <div class="auth-card">
          <a class="link-back" href="/">← Back</a>
          ${raw(logoMark())}
          <div class="eyebrow">One quick thing</div>
          <h1 class="headline">Who are you?</h1>
          <p class="subtext">This just shows you the right experience — you won't need to answer this again.</p>
          <div class="role-grid">
            <a class="role-card" href="/login?role=student">
              <div class="role-emoji">🎓</div>
              <div><div class="role-title">I'm a student</div><div class="role-sub">Find scholarships and schemes for yourself</div></div>
            </a>
            <a class="role-card" href="/login?role=institute">
              <div class="role-emoji">🏫</div>
              <div><div class="role-title">I'm an institute</div><div class="role-sub">Help your students find schemes, every batch, every year</div></div>
            </a>
          </div>
        </div>
      </div>`,
  }));
});

// ------------------------------------------------------------- OTP entry ---

router.get('/login', (req, res) => {
  const role = req.query.role === 'institute' ? 'institute' : 'student';
  const error = req.query.error;
  const student = role === 'student';

  res.send(layout({
    title: 'Log in or sign up',
    body: html`
      <div class="center-wrap">
        <div class="auth-card">
          <a class="link-back" href="/start">← Back</a>
          ${raw(logoMark())}
          <div class="eyebrow">${student ? 'For students' : 'For institutions'}</div>
          <h1 class="headline">Log in or sign up</h1>
          <p class="subtext">${student
            ? "Enter your email or mobile number — we'll send you a 6-digit code. Works whether you're new here or already have an account."
            : "Enter your work email — we'll send you a code. Works whether your institute is new here or already partnered with us."}</p>

          ${raw(error ? notice('danger', html`${error}`) : '')}

          <form method="post" action="/login">
            <input type="hidden" name="role" value="${role}">
            <div class="field">
              <label for="identifier">${student ? 'Email or mobile number' : 'POC work email'}</label>
              <input id="identifier" name="identifier" type="text" required inputmode="email"
                     autocomplete="${student ? 'email' : 'email'}" autocapitalize="off" spellcheck="false"
                     placeholder="${student ? 'you@example.com or 98765 43210' : 'you@institute.edu.in'}">
              ${raw(student ? html`
                <div class="hint">
                  Use an email address to get the code by email. Mobile works too, but SMS delivery
                  isn't configured yet — the code is shown on screen instead.
                </div>` : html`
                <div class="hint">
                  Any work email works. While Resend is unverified it can only deliver to the address the
                  Resend account is registered with — for any other address the code is shown on screen.
                </div>`)}
            </div>
            <button class="btn-primary" type="submit">Continue</button>
          </form>

          <p class="foot-note">${student
            ? raw(html`Institute instead? <a href="/login?role=institute">Switch to institute log in</a>`)
            : raw(html`Looking for the student app? <a href="/login?role=student">Switch to student log in</a>`)}</p>
        </div>
      </div>`,
  }));
});

router.post('/login', async (req, res) => {
  const role = req.body.role === 'institute' ? 'institute' : 'student';
  const identifier = normaliseIdentifier(role, req.body.identifier);
  if (!identifier) {
    const msg = role === 'student'
      ? 'Enter a valid email address, or a 10-digit Indian mobile number.'
      : 'That does not look like a valid email address.';
    return res.redirect(`/login?role=${role}&error=${encodeURIComponent(msg)}`);
  }
  await issueAndDeliver(identifier, { isInstitute: role === 'institute' });
  res.redirect(`/verify?role=${role}&id=${encodeURIComponent(identifier)}`);
});

// ------------------------------------------------------------- verify ------

router.get('/verify', async (req, res) => {
  const role = req.query.role === 'institute' ? 'institute' : 'student';
  const identifier = String(req.query.id || '');
  if (!identifier) return res.redirect(`/login?role=${role}`);

  const delivery = await store.getOtpDelivery(identifier);
  const byEmail = identifierIsEmail(identifier);
  const delivered = delivery?.sent === true;

  // The code is only shown on screen when it could not actually be delivered,
  // or when SHOW_DEV_OTP is on for testing. Showing it after a successful send
  // would make the email pointless and train users to expect it.
  const showCode = req.app.get('devMode')
    && (!delivered || process.env.SHOW_DEV_OTP === 'true');
  const devCode = showCode ? await store.peekOtpCode(identifier) : null;

  res.send(layout({
    title: 'Verify',
    body: html`
      <div class="center-wrap">
        <div class="auth-card">
          ${raw(logoMark())}
          <h1 class="headline">${role === 'student' ? "Verify it's you" : 'Verify your details'}</h1>
          <p class="subtext">${delivered
            ? html`We've emailed a 6-digit code. It expires in ${store.OTP_TTL_MINUTES} minutes.`
            : byEmail
              ? 'Enter the 6-digit code below.'
              : 'Enter the 6-digit code below.'}</p>
          <div class="contact-chip">${identifier} <a class="edit" href="/login?role=${role}">Edit</a></div>

          ${raw(delivered ? notice('good', html`
            <b>Code sent to ${identifier}.</b> Check your inbox — and your spam folder, since this is a
            new sender. Sent from <span class="mono">${delivery.from || senderAddress()}</span>.`) : '')}

          ${raw(!delivered && delivery?.channel === 'email' && delivery?.error ? notice('warn', html`
            <b>We couldn't email that code.</b> ${delivery.error}<br>
            The code is shown below so you can still continue.`) : '')}

          ${raw(!delivered && delivery?.channel === 'sms' ? notice('info', html`
            <b>No SMS provider is configured</b>, so the code is shown below instead of being texted.
            Sign in with an email address to receive it by email.`) : '')}

          ${raw(devCode ? html`
            <div class="dev-otp">
              <b>${devCode}</b><br>
              ${delivered
                ? 'Also shown here because SHOW_DEV_OTP=true. Turn that off in .env before any real pilot.'
                : 'Shown here because the code could not be delivered. Wire up a provider before any real pilot.'}
            </div>` : '')}

          ${raw(req.query.error ? notice('danger', html`${req.query.error}`) : '')}

          <form method="post" action="/verify" id="otpForm">
            <input type="hidden" name="role" value="${role}">
            <input type="hidden" name="id" value="${identifier}">
            <div class="otp-row" id="otpGroup">
              ${raw(Array.from({ length: 6 }, (_, i) =>
                `<input name="d${i}" maxlength="1" inputmode="numeric" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" required>`).join(''))}
            </div>
            <button class="btn-primary" type="submit">Verify &amp; continue</button>
          </form>

          <p class="resend" style="margin-top:16px">Didn't get it?
            <a href="/resend?role=${role}&id=${encodeURIComponent(identifier)}">Resend code</a></p>
        </div>
      </div>`,
  }));
});

router.get('/resend', async (req, res) => {
  const role = req.query.role === 'institute' ? 'institute' : 'student';
  const identifier = String(req.query.id || '');
  if (identifier) await issueAndDeliver(identifier, { isInstitute: role === 'institute' });
  res.redirect(`/verify?role=${role}&id=${encodeURIComponent(identifier)}`);
});

router.post('/verify', async (req, res) => {
  const role = req.body.role === 'institute' ? 'institute' : 'student';
  const identifier = String(req.body.id || '');
  const code = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5'].map((k) => req.body[k] ?? '').join('');

  const result = await store.verifyOtp(identifier, code);
  if (!result.ok) {
    return res.redirect(`/verify?role=${role}&id=${encodeURIComponent(identifier)}&error=${encodeURIComponent(result.reason)}`);
  }

  const existing = await store.findUser(identifier);
  if (existing) {
    const token = await store.createSession(existing.id);
    res.cookie('sc_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400000 });
    return res.redirect(existing.role === 'institute' ? '/institute' : '/dashboard');
  }

  // New contact — collect details and the Terms acceptance.
  res.cookie('sc_pending', identifier, { httpOnly: true, sameSite: 'lax', maxAge: 3600000 });
  res.redirect(`/signup?role=${role}`);
});

// -------------------------------------------------------------- sign-up ----

router.get('/signup', (req, res) => {
  const role = req.query.role === 'institute' ? 'institute' : 'student';
  const identifier = req.cookies?.sc_pending;
  if (!identifier) return res.redirect(`/login?role=${role}`);
  const error = req.query.error;

  // If they signed in with an email we already have it — don't ask twice.
  const signedInWithEmail = identifierIsEmail(identifier);

  const studentFields = html`
    <div class="field">
      <label for="name">Your name</label>
      <input id="name" name="name" type="text" required placeholder="e.g. Ananya Sharma" autocomplete="name">
    </div>
    ${raw(signedInWithEmail ? html`
      <div class="field">
        <label>Email address</label>
        <div class="contact-chip" style="margin-bottom:0">
          ${identifier} <span class="tag tag-verified" style="padding:3px 8px;">✓ Verified</span>
        </div>
        <div class="hint">We'll send your scheme deadlines here.</div>
      </div>` : html`
      <div class="field">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
        <div class="hint">We'll send your scheme deadlines here.</div>
      </div>`)}`;

  const instituteFields = html`
    <div class="field">
      <label for="institute">Institute name</label>
      <input id="institute" name="institute" type="text" required placeholder="e.g. St. Xavier's College, Mumbai">
    </div>
    <div class="field">
      <label for="name">POC name</label>
      <input id="name" name="name" type="text" required placeholder="e.g. Rohan Verma" autocomplete="name">
    </div>`;

  const studentConsent = html`
    <div class="consent-row">
      <input type="checkbox" id="consent" name="consent" value="yes" required>
      <label for="consent">I have read and agree to the
        <a href="/terms" target="_blank" rel="noopener">Terms &amp; Conditions</a> and
        <a href="/terms#t11" target="_blank" rel="noopener">Privacy Policy</a>.
        <span class="consent-sub">Under 18? Tick the box below — a parent or guardian must consent with you.</span>
      </label>
    </div>

    <div class="consent-row">
      <input type="checkbox" id="isMinor" name="isMinor" value="yes" data-toggles="guardianBox">
      <label for="isMinor">I am under 18 years old.
        <span class="consent-sub">The DPDP Act 2023 requires verifiable consent from a parent or guardian.</span>
      </label>
    </div>

    <div class="guardian-box" id="guardianBox">
      <div class="field">
        <label for="guardianName">Parent or guardian's name</label>
        <input id="guardianName" name="guardianName" type="text" placeholder="e.g. Meera Sharma">
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="guardianContact">Parent or guardian's mobile or email</label>
        <input id="guardianContact" name="guardianContact" type="text" placeholder="For confirming consent">
        <div class="hint">We record this as the consent contact. A real deployment must verify it before the profile is used.</div>
      </div>
    </div>`;

  const instituteConsent = html`
    <div class="consent-row">
      <input type="checkbox" id="consent" name="consent" value="yes" required>
      <label for="consent">I am authorised to accept on behalf of my institute, and I agree to the
        <a href="/terms" target="_blank" rel="noopener">Terms &amp; Conditions</a>, including the
        <a href="/terms#t10" target="_blank" rel="noopener">institute data obligations</a>.
        <span class="consent-sub">Includes obtaining verifiable parental consent under the DPDP Act 2023 before
        uploading data for any student under 18.</span>
      </label>
    </div>`;

  res.send(layout({
    title: 'Create your account',
    body: html`
      <div class="center-wrap">
        <div class="auth-card">
          ${raw(logoMark())}
          <div class="eyebrow">${role === 'student' ? 'New here — welcome' : 'New institute — welcome'}</div>
          <h1 class="headline">${role === 'student' ? 'Just two more details' : 'Just a couple more details'}</h1>
          <p class="subtext">${role === 'student'
            ? 'So we know who you are and where to send updates.'
            : 'So we can set up the right dashboard for your institute.'}</p>

          ${raw(error ? notice('danger', html`${error}`) : '')}

          <form method="post" action="/signup" id="signupForm">
            <input type="hidden" name="role" value="${role}">
            ${raw(role === 'student' ? studentFields : instituteFields)}
            ${raw(role === 'student' ? studentConsent : instituteConsent)}
            <button class="btn-primary" type="submit" id="signupSubmit" disabled>Continue</button>
          </form>

          <p class="foot-note">Your details are used only to match you with government schemes.
            <a href="/terms" target="_blank" rel="noopener">Read the full terms</a></p>
        </div>
      </div>`,
  }));
});

router.post('/signup', async (req, res) => {
  const role = req.body.role === 'institute' ? 'institute' : 'student';
  const identifier = req.cookies?.sc_pending;
  if (!identifier) return res.redirect(`/login?role=${role}`);

  const fail = (msg) => res.redirect(`/signup?role=${role}&error=${encodeURIComponent(msg)}`);

  // The consent gate. The disabled button is a convenience; this is the gate.
  if (req.body.consent !== 'yes') {
    return fail('You must accept the Terms & Conditions before we can create your account.');
  }

  const name = String(req.body.name || '').trim();
  if (name.length < 2) return fail('Please enter your name.');

  const isMinor = req.body.isMinor === 'yes';
  const guardianName = String(req.body.guardianName || '').trim();
  const guardianContact = String(req.body.guardianContact || '').trim();

  // DPDP Act: a self-declared minor cannot proceed without guardian details.
  if (role === 'student' && isMinor && (!guardianName || !guardianContact)) {
    return fail('Because you are under 18, we need a parent or guardian\'s name and contact before creating your profile.');
  }

  // A student who signed in by email already has a verified address.
  const email = role === 'institute' || identifierIsEmail(identifier)
    ? identifier
    : String(req.body.email || '').trim();

  const user = await store.createUser({ identifier, role, name, email });

  await store.recordConsent({
    userId: user.id,
    role,
    termsVersion: TERMS_VERSION,
    isMinor,
    guardianName: isMinor ? guardianName : null,
    guardianContact: isMinor ? guardianContact : null,
  });

  if (role === 'institute') {
    await store.createInstitute({
      name: String(req.body.institute || '').trim() || 'Unnamed institute',
      pocUserId: user.id,
      pocName: name,
    });
  }

  const token = await store.createSession(user.id);
  res.clearCookie('sc_pending');
  res.cookie('sc_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400000 });
  res.redirect(role === 'institute' ? '/institute/welcome' : '/onboarding');
});

router.get('/logout', async (req, res) => {
  const token = req.cookies?.sc_session;
  if (token) await store.destroySession(token);
  res.clearCookie('sc_session');
  res.redirect('/');
});
