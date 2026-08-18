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
import { MIN_PASSWORD_LENGTH } from '../store.js';
import { TERMS_VERSION } from '../terms.js';
import { sendOtpEmail, isEmailConfigured, senderAddress } from '../mailer.js';
import { rateLimited, clientIp, sessionCookie } from '../security.js';

export const router = express.Router();

const cookieOptions = (req) => sessionCookie({ production: req.app.get('production') });

/**
 * How people sign in.
 *
 * 'otp' is what the PRD and the approved wireframes specify and stays the
 * default. It needs a deployment that can actually send mail, which not every
 * host allows — Render blocks outbound SMTP on free instances, and an email API
 * will only send to arbitrary recipients from a verified domain. 'password'
 * exists so the product still works where neither is available.
 */
export const authMode = () =>
  process.env.AUTH_MODE === 'password' ? 'password' : 'otp';

/**
 * Repeated wrong passwords are throttled the same way OTP issuance is.
 *
 * Only in password mode. This middleware sits on the first matching /login
 * route, so without the guard it also ran for OTP sign-in — where its lower
 * limit quietly became the effective cap instead of the OTP one.
 */
const passwordThrottle = rateLimited({
  name: 'login',
  limit: 10,
  windowMinutes: 15,
  keys: (req) => [
    `id:${normaliseIdentifier(req.body?.role, req.body?.identifier) ?? 'invalid'}`,
    `ip:${clientIp(req)}`,
  ],
  onBlocked: (req, res) => {
    const role = req.body?.role === 'institute' ? 'institute' : 'student';
    res.redirect(429, `/login?role=${role}&error=${encodeURIComponent(
      'Too many sign-in attempts. Wait a few minutes and try again.')}`);
  },
});

const throttleLogin = (req, res, next) =>
  (authMode() === 'password' ? passwordThrottle(req, res, next) : next());

/**
 * OTP issuance is throttled per contact and per IP.
 *
 * Unthrottled, POST /login was free email-bombing of any address and would
 * exhaust the sending quota within minutes. Either limit alone is trivially
 * sidestepped, so both apply.
 */
const OTP_WINDOW_MINUTES = 15;
const OTP_PER_CONTACT = 5;
// Deliberately much higher than the per-contact limit. A school computer room,
// a college wifi or any carrier-NAT address is many legitimate students behind
// one IP, and a tight per-IP cap would lock all of them out together. This is
// here to stop a flood, not to ration a shared connection.
const OTP_PER_IP = 40;

function throttle(bucket, limit) {
  return rateLimited({
    name: 'otp',
    limit,
    windowMinutes: OTP_WINDOW_MINUTES,
    keys: bucket,
    onBlocked: (req, res) => {
      const role = (req.body?.role ?? req.query?.role) === 'institute' ? 'institute' : 'student';
      const msg = 'Too many codes requested. Wait a few minutes and try again.';
      // res.redirect(status, url) — res.status(429).redirect(url) would be
      // overwritten with a 302 by Express.
      res.redirect(429, `/login?role=${role}&error=${encodeURIComponent(msg)}`);
    },
  });
}

const throttleOtp = [
  throttle((req) => [
    `id:${normaliseIdentifier(req.body?.role ?? req.query?.role, req.body?.identifier ?? req.query?.id) ?? 'invalid'}`,
  ], OTP_PER_CONTACT),
  throttle((req) => [`ip:${clientIp(req)}`], OTP_PER_IP),
];

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
async function issueAndDeliver(identifier, { isInstitute = false, ip = null } = {}) {
  const code = await store.issueOtp(identifier, { ip });

  if (!identifierIsEmail(identifier)) {
    console.log(`\n  [OTP] ${identifier} -> ${code}   (no SMS provider configured — shown on screen)\n`);
    return store.recordOtpDelivery(identifier, {
      channel: 'sms',
      sent: false,
      error: 'No SMS provider is configured.',
      code,
    });
  }

  if (!isEmailConfigured()) {
    console.log(`\n  [OTP] ${identifier} -> ${code}   (RESEND_API_KEY not set — shown on screen)\n`);
    return store.recordOtpDelivery(identifier, {
      channel: 'email',
      sent: false,
      error: 'RESEND_API_KEY is not set.',
      code,
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
    // Kept only when it will be printed on the verify screen anyway, i.e.
    // delivery failed or SHOW_DEV_OTP is on. See store.recordOtpDelivery.
    code,
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
  const passwordMode = authMode() === 'password';

  res.send(layout({
    title: 'Log in or sign up',
    body: html`
      <div class="center-wrap">
        <div class="auth-card">
          <a class="link-back" href="/start">← Back</a>
          ${raw(logoMark())}
          <div class="eyebrow">${student ? 'For students' : 'For institutions'}</div>
          <h1 class="headline">Log in or sign up</h1>
          <p class="subtext">${passwordMode
            ? (student
                ? "Enter your email and password. Works whether you're new here or already have an account."
                : "Enter your work email and password. Works whether your institute is new here or already partnered with us.")
            : student
              ? "Enter your email or mobile number — we'll send you a 6-digit code. Works whether you're new here or already have an account."
              : "Enter your work email — we'll send you a code. Works whether your institute is new here or already partnered with us."}</p>

          ${raw(error ? notice('danger', html`${error}`) : '')}

          <form method="post" action="/login">
            <input type="hidden" name="role" value="${role}">
            <div class="field">
              <label for="identifier">${student ? (passwordMode ? 'Email address' : 'Email or mobile number') : 'POC work email'}</label>
              <input id="identifier" name="identifier" type="text" required inputmode="email"
                     autocomplete="${student ? 'email' : 'email'}" autocapitalize="off" spellcheck="false"
                     placeholder="${student ? (passwordMode ? 'you@example.com' : 'you@example.com or 98765 43210') : 'you@institute.edu.in'}">
              ${raw(passwordMode ? '' : student ? html`
                <div class="hint">
                  Use an email address to get the code by email. Mobile works too, but SMS delivery
                  isn't configured yet — the code is shown on screen instead.
                </div>` : html`
                <div class="hint">
                  Any work email works. While Resend is unverified it can only deliver to the address the
                  Resend account is registered with — for any other address the code is shown on screen.
                </div>`)}
            </div>

            ${raw(passwordMode ? html`
              <div class="field">
                <label for="password">Password</label>
                <input id="password" name="password" type="password" required
                       autocomplete="current-password" minlength="${MIN_PASSWORD_LENGTH}"
                       placeholder="At least ${MIN_PASSWORD_LENGTH} characters">
                <div class="hint">
                  New here? Enter the password you'd like and we'll create your account.
                </div>
              </div>` : '')}

            <button class="btn-primary" type="submit">Continue</button>
          </form>

          <p class="foot-note">${student
            ? raw(html`Institute instead? <a href="/login?role=institute">Switch to institute log in</a>`)
            : raw(html`Looking for the student app? <a href="/login?role=student">Switch to student log in</a>`)}</p>
        </div>
      </div>`,
  }));
});

/**
 * Password sign-in and sign-up in one step.
 *
 * A known address with the right password signs in. An unknown one carries the
 * password forward to the details screen, where the Terms gate still applies —
 * consent is recorded before an account exists, exactly as in the OTP flow.
 *
 * What this does NOT do is prove the address belongs to the person using it.
 * There is no verification step, so anyone can register any address. That is
 * the trade for working without email, and it is why OTP remains the default.
 */
router.post('/login', throttleLogin, async (req, res, next) => {
  if (authMode() !== 'password') return next();

  const role = req.body.role === 'institute' ? 'institute' : 'student';
  const identifier = normaliseIdentifier(role, req.body.identifier);
  const password = String(req.body.password ?? '');
  const fail = (msg) => res.redirect(`/login?role=${role}&error=${encodeURIComponent(msg)}`);

  if (!identifier || !identifierIsEmail(identifier)) {
    return fail('Enter a valid email address.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const existing = await store.findUser(identifier);
  if (existing) {
    const user = await store.verifyLogin(identifier, password);
    // Deliberately one message for both "no such account" and "wrong
    // password": saying which would confirm whether an address is registered.
    if (!user) return fail('That email and password do not match.');

    const token = await store.createSession(user.id, {
      ip: clientIp(req), userAgent: req.get('user-agent'),
    });
    await store.touchLogin(user.id);
    res.cookie('sc_session', token, cookieOptions(req));
    return res.redirect(user.role === 'institute' ? '/institute' : '/dashboard');
  }

  // New address — collect name and consent before creating anything. The
  // password rides in a short-lived cookie the same way the identifier does;
  // neither authorises anything on its own, because sign-up creates the account
  // and consent record together in one transaction.
  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.app.get('production'),
    maxAge: 30 * 60 * 1000,
    path: '/',
  };
  res.cookie('sc_pending', identifier, cookie);
  res.cookie('sc_pending_pw', password, cookie);
  res.redirect(`/signup?role=${role}`);
});

router.post('/login', throttleOtp, async (req, res) => {
  const role = req.body.role === 'institute' ? 'institute' : 'student';
  const identifier = normaliseIdentifier(role, req.body.identifier);
  if (!identifier) {
    const msg = role === 'student'
      ? 'Enter a valid email address, or a 10-digit Indian mobile number.'
      : 'That does not look like a valid email address.';
    return res.redirect(`/login?role=${role}&error=${encodeURIComponent(msg)}`);
  }
  await issueAndDeliver(identifier, { isInstitute: role === 'institute', ip: clientIp(req) });
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

  /**
   * When the code appears on screen.
   *
   * Normally: only in development, and only when delivery actually failed —
   * showing it after a successful send would make the email pointless and train
   * users to expect it.
   *
   * SHOW_DEV_OTP=true overrides that anywhere, production included. Without the
   * override a production deployment with no email provider configured could
   * neither send the code nor display it, so nobody could sign in at all. It is
   * an explicit, deliberately loud escape hatch for a demo: the server warns at
   * boot and the page below says plainly that sign-in is not secured.
   */
  const forceShow = process.env.SHOW_DEV_OTP === 'true';
  const showCode = forceShow || (req.app.get('devMode') && !delivered);
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

          ${raw(devCode && forceShow && req.app.get('production') ? notice('danger', html`
            <b>Demonstration mode.</b> Sign-in codes are shown on this screen, so anyone can sign in as
            anyone. This build is for demonstration only — do not enter real personal details.`) : '')}

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

router.get('/resend', throttleOtp, async (req, res) => {
  const role = req.query.role === 'institute' ? 'institute' : 'student';
  const identifier = String(req.query.id || '');
  if (identifier) await issueAndDeliver(identifier, { isInstitute: role === 'institute', ip: clientIp(req) });
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
    const token = await store.createSession(existing.id, {
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    });
    await store.touchLogin(existing.id);
    res.cookie('sc_session', token, cookieOptions(req));
    return res.redirect(existing.role === 'institute' ? '/institute' : '/dashboard');
  }

  // New contact — collect details and the Terms acceptance.
  //
  // This cookie is a convenience that carries the identifier to the next
  // screen. It is NOT what authorises the sign-up: verifyOtp opened a
  // time-limited window on the OTP row, and pendingIdentifier() below checks
  // that window before anything is created. Previously the cookie was trusted
  // on its own, so a hand-written Cookie header registered a fully verified
  // account on any address without ever receiving a code.
  res.cookie('sc_pending', identifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.app.get('production'),
    maxAge: 30 * 60 * 1000,
    path: '/',
  });
  res.redirect(`/signup?role=${role}`);
});

/** Clears both sign-up cookies. The password one must never outlive the flow. */
function clearPending(res) {
  res.clearCookie('sc_pending', { path: '/' });
  res.clearCookie('sc_pending_pw', { path: '/' });
}

/**
 * The identifier a sign-up may use, or null.
 *
 * The cookie says which contact; the database says whether that contact
 * actually completed OTP verification in the last half hour. Both must agree.
 */
async function pendingIdentifier(req) {
  const claimed = req.cookies?.sc_pending;
  if (!claimed) return null;

  // In password mode there is no code to have consumed, so the cookie is all
  // there is. That is the honest cost of signing in without email: the address
  // is never proven to belong to the person registering it.
  if (authMode() === 'password') {
    return req.cookies?.sc_pending_pw ? claimed : null;
  }

  return (await store.identifierAwaitingSignup(claimed)) ? claimed : null;
}

// -------------------------------------------------------------- sign-up ----

router.get('/signup', async (req, res) => {
  const role = req.query.role === 'institute' ? 'institute' : 'student';
  const identifier = await pendingIdentifier(req);
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
  const identifier = await pendingIdentifier(req);
  if (!identifier) {
    // Either the window expired, or the cookie was never backed by a verified
    // code. Send them back through the real flow rather than saying which.
    clearPending(res);
    return res.redirect(`/login?role=${role}&error=${encodeURIComponent(
      authMode() === 'password'
        ? 'That took too long. Enter your email and password again.'
        : 'Please verify your contact again before creating your account.')}`);
  }

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

  // Account, consent record and institute in one transaction. A crash between
  // them previously left a user with no consent record — exactly the state the
  // terms gate exists to prevent.
  let user;
  try {
    ({ user } = await store.createAccount({
      identifier,
      role,
      name,
      email,
      ip: clientIp(req),
      termsVersion: TERMS_VERSION,
      isMinor,
      guardianName,
      guardianContact,
      instituteName: role === 'institute'
        ? String(req.body.institute || '').trim()
        : null,
      password: authMode() === 'password' ? req.cookies?.sc_pending_pw : null,
    }));
  } catch (err) {
    // Unique violation: the contact was registered between verification and
    // this submit. Log them in rather than showing an error.
    if (err.code === '23505') {
      const existing = await store.findUser(identifier);
      if (existing) {
        const token = await store.createSession(existing.id, {
          ip: clientIp(req), userAgent: req.get('user-agent'),
        });
        clearPending(res);
        res.cookie('sc_session', token, cookieOptions(req));
        return res.redirect(existing.role === 'institute' ? '/institute' : '/dashboard');
      }
    }
    throw err;
  }

  const token = await store.createSession(user.id, {
    ip: clientIp(req), userAgent: req.get('user-agent'),
  });
  clearPending(res);
  res.cookie('sc_session', token, cookieOptions(req));
  res.redirect(role === 'institute' ? '/institute/welcome' : '/onboarding');
});

router.get('/logout', async (req, res) => {
  const token = req.cookies?.sc_session;
  if (token) await store.destroySession(token);
  res.clearCookie('sc_session', { path: '/' });
  res.redirect('/');
});
