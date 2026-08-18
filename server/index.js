/**
 * SchemeConnect server.
 *
 * Server-rendered Express app. All scheme data comes from the scraper's
 * catalog file; this process never fetches from a government site itself.
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
import { isEmailConfigured, senderAddress, senderDomain, replyToAddress, FALLBACK_SENDER } from './mailer.js';
import * as store from './store.js';

/**
 * Load .env before anything reads process.env. Node's built-in loader means no
 * dotenv dependency; a missing file is fine (the app degrades to on-screen OTP).
 */
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  console.log('  (no .env file — email delivery will be disabled)');
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // reachable from a phone on the same wifi
const DEV = process.env.NODE_ENV !== 'production';
app.set('devMode', DEV);
app.set('trust proxy', 1);

// Batch uploads post as a form field: CSV as text, .xlsx base64-encoded.
// Base64 inflates by ~33%, so the limit sits comfortably above the 6 MB the
// client accepts.
app.use(express.urlencoded({ extended: false, limit: '12mb' }));
app.use(express.json({ limit: '12mb' }));

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

/** Attaches req.user when a valid session cookie is present. */
app.use(async (req, res, next) => {
  const token = req.cookies?.sc_session;
  if (token) {
    const session = await store.getSession(token);
    if (session) req.user = await store.getUser(session.userId);
  }
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    maxAge: DEV ? 0 : '1h',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);

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

const server = app.listen(PORT, HOST, async () => {
  const meta = await catalogMeta();
  console.log('');
  console.log('  SchemeConnect');
  console.log(`  →  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`     http://${ip}:${PORT}   (same wifi, e.g. your phone)`);
  }
  console.log('');
  if (meta.exists) {
    console.log(`  Catalogue: ${meta.total} schemes (${meta.matchable} with criteria) from ${meta.sources.length} government domain(s)`);
    console.log(`  Generated: ${meta.generatedAt}`);
  } else {
    console.log('  Catalogue: EMPTY — run "npm run scrape" to populate it.');
  }

  if (isEmailConfigured()) {
    console.log(`\n  Email OTP: ON via Resend, from ${senderAddress()}`);
    if (replyToAddress()) console.log(`             replies go to ${replyToAddress()}`);
    console.log(`             if ${senderDomain()} is not yet verified, sends fall back to ${FALLBACK_SENDER}`);
    if (process.env.SHOW_DEV_OTP === 'true') {
      console.log('             SHOW_DEV_OTP=true — codes also shown on screen.');
    }
  } else {
    console.log('\n  Email OTP: OFF (no RESEND_API_KEY) — codes shown on screen.');
  }
  console.log('  SMS OTP:   OFF (no provider) — mobile codes are shown on screen.');
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await store.flush();
    server.close(() => process.exit(0));
  });
}
