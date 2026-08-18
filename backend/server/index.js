/**
 * SchemeConnect server.
 *
 * Server-rendered Express app. Every account, consent record and scheme lives
 * in PostgreSQL; this process never fetches from a government site itself and
 * never reads application data from disk.
 */

import express from 'express';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { PUBLIC_DIR, ROOT } from '../config/paths.js';
import { layout, html, raw, logoMark } from './render.js';
import { router as publicRouter } from './routes/public.js';
import { router as authRouter } from './routes/auth.js';
import { router as studentRouter } from './routes/student.js';
import { router as instituteRouter } from './routes/institute.js';
import { router as opsRouter } from './routes/ops.js';
import { catalogMeta } from './catalog.js';
import { isEmailConfigured, senderAddress, senderDomain, replyToAddress, FALLBACK_SENDER, transport } from './mailer.js';
import * as store from './store.js';
import * as db from './db.js';
import { csrf, securityHeaders, initSecret } from './security.js';

/**
 * Load .env before anything reads process.env. Node's built-in loader means no
 * dotenv dependency; a missing file is fine as long as DATABASE_URL is set some
 * other way.
 */
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  console.log('  (no .env file — reading configuration from the environment)');
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // reachable from a phone on the same wifi
const PRODUCTION = process.env.NODE_ENV === 'production';
const DEV = !PRODUCTION;

app.set('devMode', DEV);
app.set('production', PRODUCTION);
app.set('trust proxy', 1);

// ------------------------------------------------------------ preflight ----

/**
 * Refuse to start rather than serve a site that silently forgets everything.
 *
 * The previous version fell back to a JSON file on the local disk, which on an
 * ephemeral filesystem meant every deploy wiped every account without any
 * visible failure.
 */
async function preflight() {
  if (!db.isConfigured()) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
      '  SchemeConnect stores every account, consent record and scheme in PostgreSQL.\n' +
      '  Copy .env.example to .env, point DATABASE_URL at a database, then run:\n' +
      '    npm run migrate && npm run import:catalog'
    );
  }

  try {
    await db.healthcheck();
  } catch (err) {
    if (err.code === '42P01') {
      throw new Error(
        'The database is reachable but has no schema. Run:\n' +
        '    npm run migrate'
      );
    }
    throw new Error(`Cannot reach the database: ${err.message}`);
  }

  if (db.tlsIsUnverified()) {
    console.warn(
      '\n  WARNING: PGSSL_NO_VERIFY=true — the database connection is encrypted\n' +
      '  but the certificate is not checked. Download your provider\'s CA\n' +
      '  certificate, set PGSSL_CA_FILE to it, and remove PGSSL_NO_VERIFY.\n');
  }

  if (PRODUCTION && process.env.SHOW_DEV_OTP === 'true') {
    console.warn(
      '\n  WARNING: SHOW_DEV_OTP=true in production. Sign-in codes are printed on\n' +
      '  the verify screen, so anyone can sign in as anyone. This is a demo\n' +
      '  setting. Configure RESEND_API_KEY and unset it before real users.\n');
  }

  const { generated } = initSecret({ production: PRODUCTION });
  if (generated) {
    console.log('  (SESSION_SECRET not set — generated one for this process; set it before deploying)');
  }
}

// ---------------------------------------------------------- middleware -----

// Batch uploads post as a form field: CSV as text, .xlsx base64-encoded.
// Base64 inflates by ~33%, so the limit sits comfortably above the 6 MB the
// client accepts.
app.use(express.urlencoded({ extended: false, limit: '12mb' }));
app.use(express.json({ limit: '12mb' }));

app.use(securityHeaders({ production: PRODUCTION }));

/** Minimal cookie parsing — one small need, not worth a dependency. */
app.use((req, res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return i === -1 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      })
  );
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    maxAge: DEV ? 0 : '1h',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);

// Liveness, before auth so a load balancer can reach it.
app.get('/healthz', async (req, res) => {
  try {
    const health = await db.healthcheck();
    res.json({ ok: true, ...health });
  } catch (err) {
    // Fail the check when the pool cannot reach the database, so a bad deploy
    // is not rolled out serving empty catalogues.
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use(csrf({ production: PRODUCTION }));

/** Attaches req.user when a valid, unexpired session cookie is present. */
app.use(async (req, res, next) => {
  const token = req.cookies?.sc_session;
  if (!token) return next();
  try {
    const session = await store.getSession(token);
    if (session) req.user = await store.getUser(session.userId);
    // An expired or unknown token: clear it so the browser stops sending it.
    else res.clearCookie('sc_session', { path: '/' });
  } catch (err) {
    return next(err);
  }
  next();
});

app.use(publicRouter);
app.use(authRouter);
// Mounted under their own prefixes so each router's auth guard only ever
// applies to its own routes. The student router sits at the root because its
// paths (/dashboard, /profile, /saved…) are top-level, so it guards by path.
app.use('/institute', instituteRouter);
app.use('/ops', opsRouter);
app.use(studentRouter);

// ---------------------------------------------------------------- 404 ------

app.use((req, res) => {
  res.status(404).send(layout({
    title: 'Not found',
    body: html`
      <div class="center-wrap">
        <div class="auth-card" style="text-align:center">
          ${raw(logoMark())}
          <h1 class="headline" style="margin-top:24px">Page not found</h1>
          <p class="subtext">We couldn't find <span class="mono">${req.path}</span>.</p>
          <a class="btn-primary" href="/">Back to home</a>
          <a class="btn-ghost" href="/schemes">Browse all schemes</a>
        </div>
      </div>`,
  }));
});

// ---------------------------------------------------------------- 500 ------

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send(layout({
    title: 'Something went wrong',
    body: html`
      <div class="center-wrap">
        <div class="auth-card" style="text-align:center">
          ${raw(logoMark())}
          <h1 class="headline" style="margin-top:24px">Something went wrong</h1>
          <p class="subtext">The error has been logged to the server console.</p>
          ${raw(DEV ? html`<pre class="mono" style="text-align:left;white-space:pre-wrap;background:var(--bg);padding:14px;border-radius:10px;font-size:11.5px;overflow:auto">${err.stack || err.message}</pre>` : '')}
          <a class="btn-primary" href="/">Back to home</a>
        </div>
      </div>`,
  }));
});

/** LAN addresses, so the site can be opened on a phone on the same network. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/**
 * Optionally keeps a serverless database awake.
 *
 * Neon suspends an idle compute after five minutes on every plan. Waking it
 * costs one slow query, not an outage — but the first visitor of a quiet
 * morning is the one who pays it.
 *
 * This is off by default, and deliberately so. Neon's Free plan includes 100
 * CU-hours per project per month; a month is about 730 hours, so pinging a
 * compute awake around the clock exhausts a free project's whole allowance in
 * roughly four days. Only turn this on where the compute hours are paid for,
 * and prefer disabling scale-to-zero in the Neon console instead — it does the
 * same thing without a timer in the app.
 */
function startKeepWarm() {
  const minutes = Number(process.env.KEEPWARM_MINUTES || 0);
  if (!minutes) return null;

  const timer = setInterval(async () => {
    try {
      await db.query('select 1');
    } catch (err) {
      console.error('keep-warm ping failed:', err.message);
    }
  }, minutes * 60 * 1000);
  timer.unref();
  console.log(`  Keep-warm: pinging the database every ${minutes} min`);
  return timer;
}

/**
 * Expired rows are deleted on a timer. The old store never collected anything:
 * failed OTPs and dead sessions accumulated for the life of the file.
 */
function startSweeps() {
  const sweep = async () => {
    try {
      const [otps, sessions, limits] = await Promise.all([
        store.sweepOtps(), store.sweepSessions(), store.sweepRateLimits(),
      ]);
      if (otps || sessions || limits) {
        console.log(`  swept ${otps} otp(s), ${sessions} session(s), ${limits} rate-limit window(s)`);
      }
    } catch (err) {
      console.error('sweep failed:', err.message);
    }
  };
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
  timer.unref(); // never hold the process open
  return timer;
}

// ----------------------------------------------------------------- boot ----

try {
  await preflight();
} catch (err) {
  console.error(`\n  SchemeConnect cannot start.\n\n  ${err.message}\n`);
  process.exit(1);
}

const server = app.listen(PORT, HOST, async () => {
  const meta = await catalogMeta();
  console.log('');
  console.log('  SchemeConnect');
  console.log(`  →  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`     http://${ip}:${PORT}   (same wifi, e.g. your phone)`);
  }
  console.log('');
  console.log(`  Database:  ${db.connectionString().replace(/:[^:@/]*@/, ':****@')}`);
  if (meta.exists) {
    console.log(`  Catalogue: ${meta.total} schemes (${meta.matchable} with criteria) from ${meta.sources.length} government domain(s)`);
    console.log(`  Verified:  ${meta.generatedAt}`);
  } else {
    console.log('  Catalogue: EMPTY — run "npm run import:catalog" or "npm run scrape".');
  }

  if (isEmailConfigured()) {
    const via = transport() === 'smtp'
      ? `SMTP (${process.env.SMTP_HOST})`
      : 'Resend';
    console.log(`\n  Email OTP: ON via ${via}, from ${senderAddress()}`);
    if (replyToAddress()) console.log(`             replies go to ${replyToAddress()}`);
    if (transport() === 'resend') {
      console.log(`             if ${senderDomain()} is not yet verified, sends fall back to ${FALLBACK_SENDER}`);
    }
    if (process.env.SHOW_DEV_OTP === 'true') {
      console.log('             SHOW_DEV_OTP=true — codes also shown on screen.');
    }
  } else {
    console.log('\n  Email OTP: OFF (no RESEND_API_KEY) — codes shown on screen.');
  }
  console.log('  SMS OTP:   OFF (no provider) — mobile codes are shown on screen.');
  console.log('');

  startSweeps();
  startKeepWarm();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    // Don't wait forever for keep-alive connections to drain.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
