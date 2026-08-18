/**
 * CSRF protection, rate limiting and cookie hardening.
 *
 * Every state-changing route here is a cookie-authenticated form POST. With no
 * token and a `sameSite: 'lax'` session cookie — which still permits cross-site
 * top-level form submissions — any page a student visited could silently POST
 * /profile/delete and erase their account, saved schemes and consent record.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as store from './store.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Secret for signing CSRF tokens.
 *
 * Generated per boot when unset, which is fine for a single dev process and
 * wrong for production: two instances would reject each other's tokens, and a
 * restart would invalidate every open form. The server refuses to start in
 * production without it.
 */
let secret = null;

export function initSecret({ production }) {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) {
    secret = configured;
    return { generated: false };
  }
  if (production) {
    throw new Error(
      'SESSION_SECRET is not set, or is shorter than 32 characters.\n' +
      '  It signs CSRF tokens. Generate one with:\n' +
      '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  secret = randomUUID() + randomUUID();
  return { generated: true };
}

const sign = (value) => createHmac('sha256', secret).update(String(value)).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Issues a CSRF cookie and exposes the matching token on the response.
 *
 * Signed double-submit: the cookie holds a random id, the form holds an HMAC of
 * that id. An attacker cannot compute the HMAC without the secret, and cannot
 * read the cookie from another origin.
 */
export function csrf({ production }) {
  return function csrfMiddleware(req, res, next) {
    let id = req.cookies?.sc_csrf;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = randomUUID();
      res.cookie('sc_csrf', id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: production,
        maxAge: 86400000,
        path: '/',
      });
    }
    const token = sign(id);
    res.locals.csrfToken = token;

    // Inject the hidden field into every rendered page, rather than adding a
    // line to each of the fifteen templates. Forgetting one is the standard way
    // CSRF protection ends up partial.
    const send = res.send.bind(res);
    res.send = (body) =>
      send(typeof body === 'string' && body.startsWith('<!DOCTYPE html')
        ? injectCsrfField(body, token)
        : body);

    if (SAFE_METHODS.has(req.method)) return next();

    const supplied = req.body?._csrf || req.get('x-csrf-token') || '';
    if (!supplied || !safeEqual(supplied, res.locals.csrfToken)) {
      return res.status(403).send(csrfFailurePage(req));
    }
    next();
  };
}

function csrfFailurePage(req) {
  const back = req.get('referer') || '/';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session expired · SchemeConnect</title>
<link rel="stylesheet" href="/css/app.css"></head><body>
<div class="center-wrap"><div class="auth-card" style="text-align:center">
<h1 class="headline">That form has expired</h1>
<p class="subtext">For your security we could not confirm this request came from SchemeConnect.
This usually means the page was open for a long time. Go back and try again.</p>
<a class="btn-primary" href="${back.replace(/"/g, '&quot;')}">Go back</a>
<a class="btn-ghost" href="/">Home</a>
</div></div></body></html>`;
}

/**
 * Injects the CSRF field into every same-origin POST form in a rendered page.
 *
 * Done centrally rather than by hand in each template. Fifteen forms, each
 * needing a line nobody can forget — forgetting one is the standard way CSRF
 * protection ends up partial, and a missed form fails closed here (403) rather
 * than silently staying unprotected.
 */
export function injectCsrfField(markup, token) {
  return String(markup).replace(
    /(<form\b[^>]*\bmethod\s*=\s*["']?post["']?[^>]*>)/gi,
    (openTag) => `${openTag}<input type="hidden" name="_csrf" value="${token}">`
  );
}

// -------------------------------------------------------- rate limiting ----

/**
 * Throttles a route by a caller-supplied key.
 *
 * OTP issuance was unthrottled: free email-bombing of any address, and the
 * Resend quota gone within minutes. Limits are applied per identifier AND per
 * IP, because either alone is trivially sidestepped.
 */
export function rateLimited({ name, limit, windowMinutes, keys, onBlocked }) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const buckets = keys(req).filter(Boolean).map((k) => `${name}:${k}`);
      for (const bucket of buckets) {
        const { allowed } = await store.rateLimit(bucket, { limit, windowMinutes });
        if (!allowed) return onBlocked(req, res);
      }
    } catch (err) {
      // A limiter that cannot reach the database must not take the site down.
      console.error('rate limit check failed:', err.message);
    }
    next();
  };
}

/** Client IP, honouring the proxy header only because trust proxy is set. */
export const clientIp = (req) => req.ip || req.socket?.remoteAddress || null;

// ------------------------------------------------------------- headers ----

/** A small set of headers with no configuration and no dependency. */
export function securityHeaders({ production }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // Inline styles are used throughout the templates for one-off spacing.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; ');

  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', csp);
    if (production) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}

/** Cookie options for the session, consistent across every set-cookie call. */
export function sessionCookie({ production }) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    maxAge: 30 * 86400000,
    path: '/',
  };
}
