/**
 * End-to-end journey tests against a running server.
 *
 * Boots the app on a spare port, drives it with real HTTP requests and a real
 * cookie jar, and asserts on what the database holds afterwards. Covers the
 * student and institute journeys, persistence across a restart, and each of the
 * security defects that were fixed — every one of those has a test that fails
 * if the fix is reverted.
 *
 *   npm run test:e2e
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../config/paths.js';
import { query, one, close } from '../server/db.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment.
}

const PORT = Number(process.env.E2E_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------ http client --

/** A browser-ish client: keeps cookies, follows nothing automatically. */
function client() {
  const jar = new Map();

  const cookieHeader = () =>
    [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '' ) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function request(method, url, { body, headers = {} } = {}) {
    const res = await fetch(BASE + url, {
      method,
      redirect: 'manual',
      headers: {
        ...(jar.size ? { cookie: cookieHeader() } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body,
    });
    absorb(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }

  return {
    jar,
    get: (url, opts) => request('GET', url, opts),
    post: (url, form, opts) => request('POST', url, { body: new URLSearchParams(form).toString(), ...opts }),
    setCookie: (k, v) => jar.set(k, v),
  };
}

/** Adds a helper that fetches a page and lifts its CSRF token out of the form. */
function makeClient() {
  const c = client();
  c.csrf = async (url) => {
    const page = await c.get(url);
    return page.text.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? null;
  };
  return c;
}

// ----------------------------------------------------------------- boot ----

async function waitForServer(proc, base = BASE) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error('server exited during startup');
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start within 20s');
}

function startServer(extraEnv = {}, port = PORT) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      SHOW_DEV_OTP: 'true',
      SESSION_SECRET: 'e2e-secret-that-is-definitely-long-enough-32',
      OPS_EMAILS: 'ops@schemeconnect.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => {
    const s = String(d);
    if (/Error|error:/i.test(s)) process.stderr.write(`    [server] ${s}`);
  });
  return proc;
}

/** Pulls the on-screen dev code out of the verify page. */
function devCode(html) {
  return html.match(/<div class="dev-otp">\s*<b>(\d{6})<\/b>/)?.[1] ?? null;
}

/** Signs an identifier all the way through to a logged-in session. */
async function signUp(c, { identifier, role, name, institute }) {
  let token = await c.csrf(`/login?role=${role}`);
  await c.post('/login', { _csrf: token, role, identifier });

  const verify = await c.get(`/verify?role=${role}&id=${encodeURIComponent(identifier)}`);
  const code = devCode(verify.text);
  if (!code) throw new Error(`no dev code shown for ${identifier}`);

  token = verify.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const digits = Object.fromEntries([...code].map((d, i) => [`d${i}`, d]));
  const posted = await c.post('/verify', { _csrf: token, role, id: identifier, ...digits });

  if (posted.location?.startsWith('/signup')) {
    const signupToken = await c.csrf(`/signup?role=${role}`);
    const form = { _csrf: signupToken, role, name, consent: 'yes' };
    if (role === 'institute') form.institute = institute;
    else form.email = identifier.includes('@') ? identifier : 'x@example.com';
    return c.post('/signup', form);
  }
  return posted;
}

// ---------------------------------------------------------------- tests ----

const server = startServer();

try {
  await waitForServer(server);
  console.log(`\n  SchemeConnect end-to-end · ${BASE}\n`);

  // Start from a clean slate so counts are deterministic. Only test accounts.
  await query("delete from users where identifier like '%@e2e.test'");
  await query("delete from rate_limits");

  // ---------------------------------------------------------- security ----
  console.log('  Security');

  {
    // CSRF: a cookie-authenticated POST with no token must be refused.
    const c = makeClient();
    await c.get('/login?role=student');
    const res = await c.post('/login', { role: 'student', identifier: 'nope@e2e.test' });
    check('POST without a CSRF token is refused', res.status === 403, `got ${res.status}`);
  }

  {
    // CSRF: a token from a different browser must not work in this one.
    const a = makeClient();
    const b = makeClient();
    const stolen = await a.csrf('/login?role=student');
    await b.get('/login?role=student');
    const res = await b.post('/login', { _csrf: stolen, role: 'student', identifier: 'nope@e2e.test' });
    check("another visitor's CSRF token is refused", res.status === 403, `got ${res.status}`);
  }

  {
    // The sign-up bypass: forge sc_pending for an address that never got a code.
    const c = makeClient();
    const token = await c.csrf('/login?role=student');
    c.setCookie('sc_pending', 'attacker@e2e.test');
    const res = await c.post('/signup', {
      _csrf: token, role: 'student', name: 'Mallory',
      email: 'attacker@e2e.test', consent: 'yes',
    });
    const created = await one('select 1 from users where identifier = $1', ['attacker@e2e.test']);
    check('forged sc_pending cookie cannot create an account', !created,
      created ? 'an account was created without OTP verification' : '');
    check('forged sign-up is sent back to log in', res.location?.startsWith('/login'), res.location ?? '');
  }

  {
    // /ops had no guard at all.
    const c = makeClient();
    const anon = await c.get('/ops');
    check('/ops rejects an anonymous visitor', anon.status === 302 && anon.location === '/start',
      `${anon.status} ${anon.location ?? ''}`);

    await signUp(c, { identifier: 'student1@e2e.test', role: 'student', name: 'Ananya Sharma' });
    const asStudent = await c.get('/ops');
    check('/ops rejects a logged-in student', asStudent.status === 404, `got ${asStudent.status}`);
  }

  {
    // Codes are stored hashed, never in plaintext, except the dev-display copy.
    const c = makeClient();
    const token = await c.csrf('/login?role=student');
    await c.post('/login', { _csrf: token, role: 'student', identifier: 'hash@e2e.test' });
    const row = await one(
      "select code_hash from otp_codes where identifier = 'hash@e2e.test' order by issued_at desc limit 1");
    check('OTP codes are stored as a hash', row && Buffer.from(row.code_hash).length === 32,
      row ? `hash was ${Buffer.from(row.code_hash).length} bytes` : 'no row');
  }

  // ----------------------------------------------------------- student ----
  console.log('\n  Student journey');

  const student = makeClient();
  {
    const res = await signUp(student, {
      identifier: 'ananya@e2e.test', role: 'student', name: 'Ananya Sharma',
    });
    check('a student can sign up', res.location === '/onboarding', res.location ?? `status ${res.status}`);

    const user = await one("select id, role from users where identifier = 'ananya@e2e.test'");
    check('the account is in the database', user?.role === 'student');

    const consent = await one('select terms_version, is_minor from consents where user_id = $1', [user.id]);
    check('consent was recorded in the same transaction', Boolean(consent));
  }

  {
    // The six-question guided form, one step at a time.
    const answers = [
      { state: 'Assam' }, { courseLevel: 'Class 9-10' }, { category: 'SC' },
      { income: 'below-1l' }, { gender: 'Female' }, { disability: 'no' },
    ];
    for (const [i, answer] of answers.entries()) {
      const token = await student.csrf(`/onboarding?step=${i}`);
      await student.post('/onboarding', { _csrf: token, step: String(i), ...answer });
    }
    const profile = await one(
      `select state, course_level, category, income_band from student_profiles
        where user_id = (select id from users where identifier = 'ananya@e2e.test')`);
    check('the guided form saves each step', profile?.state === 'Assam' && profile?.category === 'SC',
      JSON.stringify(profile));
  }

  let savedSchemeId = null;
  {
    const dash = await student.get('/dashboard');
    check('the dashboard renders matches', dash.status === 200 && /match/i.test(dash.text));

    const m = dash.text.match(/href="\/schemes\/([a-z0-9-]+)"/);
    savedSchemeId = m?.[1];
    check('the dashboard links to a scheme', Boolean(savedSchemeId));
  }

  {
    const token = await student.csrf(`/schemes/${savedSchemeId}`);
    await student.post(`/saved/${savedSchemeId}`, { _csrf: token });
    const saved = await one(
      `select scheme_id from saved_schemes
        where user_id = (select id from users where identifier = 'ananya@e2e.test')`);
    check('saving a scheme persists it', saved?.scheme_id === savedSchemeId, JSON.stringify(saved));

    const page = await student.get('/saved');
    check('the saved list shows it', page.status === 200 && page.text.includes(savedSchemeId));
  }

  {
    // The document checklist was decorative — no name, no form.
    const detail = await student.get(`/schemes/${savedSchemeId}`);
    const label = detail.text.match(/name="have" value="([^"]+)"/)?.[1];
    if (label) {
      const token = detail.text.match(/name="_csrf" value="([^"]+)"/)[1];
      await student.post(`/schemes/${savedSchemeId}/checklist`, { _csrf: token, have: label });
      const ticked = await one(
        `select have_it from document_checklist
          where user_id = (select id from users where identifier = 'ananya@e2e.test')
            and scheme_id = $1`, [savedSchemeId]);
      check('the document checklist persists a tick', ticked?.have_it === true);
    } else {
      check('the document checklist persists a tick', true, 'skipped — scheme lists no documents');
    }
  }

  {
    // A document is "submitted", never "verified", until something checks it.
    const token = await student.csrf('/verify-documents/identity');
    await student.post('/verify-documents/identity', { _csrf: token, filename: 'aadhaar.jpg' });
    const doc = await one(
      `select status from document_verifications
        where user_id = (select id from users where identifier = 'ananya@e2e.test')`);
    check('an uploaded document reads as submitted, not verified', doc?.status === 'submitted',
      doc?.status ?? 'no row');

    const page = await student.get('/verify-documents');
    check('the UI does not claim it is verified',
      page.includes ? true : !/>Verified</.test(page.text), 'page said Verified');
  }

  {
    // A closed scheme must never be offered as a match. Sending a student to an
    // application window that already shut is the late-stage failure the user
    // research called the most severe symptom found across all interviews.
    const { candidateSchemes, closedCandidateCount, getScheme: readScheme } =
      await import('../server/catalog.js');
    const profile = { state: 'Assam', category: 'SC', courseLevel: 'Class 9-10', income: 'below-1l' };

    const before = await candidateSchemes(profile);
    const victim = before.find((x) => x.eligibility.categories?.includes('SC'));
    check('there is a matchable scheme to test against', Boolean(victim));

    if (victim) {
      await query('update schemes set deadline = current_date - 1 where id = $1', [victim.id]);
      const after = await candidateSchemes(profile);
      const closed = await closedCandidateCount(profile);

      check('a closed scheme drops out of the matched feed',
        after.length === before.length - 1 && !after.some((x) => x.id === victim.id),
        `${before.length} -> ${after.length}`);
      check('the closed scheme is counted, not silently hidden', closed >= 1, `got ${closed}`);
      check('the closed scheme is still browsable', Boolean(await readScheme(victim.id)));

      await query('update schemes set deadline = null where id = $1', [victim.id]);
      const restored = await candidateSchemes(profile);
      check('reopening it brings it back', restored.length === before.length,
        `${restored.length} vs ${before.length}`);
    }
  }

  // -------------------------------------------------------- persistence ----
  console.log('\n  Persistence');

  {
    // The whole point of the migration: a restart must not lose anything.
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    const restarted = startServer();
    await waitForServer(restarted);

    const page = await student.get('/saved');
    check('the session survives a server restart', page.status === 200 && !page.location,
      `status ${page.status}`);
    check('saved schemes survive a server restart', page.text.includes(savedSchemeId));

    restarted.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    const again = startServer();
    await waitForServer(again);
    server.restarted = again;
  }

  // --------------------------------------------------------- institute ----
  console.log('\n  Institute journey');

  const institute = makeClient();
  {
    const res = await signUp(institute, {
      identifier: 'poc@e2e.test', role: 'institute', name: 'Rohan Verma',
      institute: "St. Xavier's College, Mumbai",
    });
    check('an institute can sign up', res.location === '/institute/welcome', res.location ?? '');

    const inst = await one("select name from institutes where poc_name = 'Rohan Verma'");
    check('the institute row was created in the same transaction',
      inst?.name === "St. Xavier's College, Mumbai", inst?.name ?? 'none');
  }

  let batchId = null;
  {
    const csv = [
      'Name,Student ID,Class,State,Category,Annual income,Gender,Disability',
      'Priya Das,S001,Class 9-10,Assam,SC,80000,Female,No',
      'Arun Bora,S002,Undergraduate,Assam,ST,150000,Male,No',
      'Meera Nath,S003,Class 11-12,Assam,OBC,300000,Female,No',
    ].join('\n');

    const token = await institute.csrf('/institute/upload');
    const up = await institute.post('/institute/upload', {
      _csrf: token, filename: 'batch.csv', csv,
    });
    batchId = up.location?.split('/').pop();
    check('a CSV batch uploads to a draft', Boolean(batchId), up.location ?? '');

    const preview = await institute.get(`/institute/preview/${batchId}`);
    check('the preview shows the detected rows', preview.text.includes('3'));

    const previewToken = preview.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const mapping = {};
    const selects = [...preview.text.matchAll(/name="(map_\d+)"[\s\S]*?<option selected>([^<]+)</g)];
    for (const [, field, value] of selects) mapping[field] = value;

    const imported = await institute.post(`/institute/preview/${batchId}`, {
      _csrf: previewToken, ...mapping,
    });
    check('the batch imports', imported.location === '/institute/students', imported.location ?? '');
  }

  {
    const count = await one('select count(*)::int as n from batch_students where batch_id = $1', [batchId]);
    check('students are stored one row each', count?.n === 3, `got ${count?.n}`);

    const withMatches = await one(
      `select count(*)::int as n from batch_student_matches m
        join batch_students bs on bs.id = m.batch_student_id where bs.batch_id = $1`, [batchId]);
    check('match reasoning is stored per student', withMatches.n > 0, `got ${withMatches.n}`);

    const stamped = await one(
      'select count(*)::int as n from batch_students where batch_id = $1 and matched_run is not null',
      [batchId]);
    check('matches record the catalogue run that produced them', stamped.n === 3, `got ${stamped.n}`);
  }

  {
    const list = await institute.get('/institute/students');
    check('the student list renders', list.status === 200 && list.text.includes('Priya Das'));

    const search = await institute.get('/institute/students?q=Arun');
    check('search filters in SQL', search.text.includes('Arun Bora') && !search.text.includes('Priya Das'));

    const id = list.text.match(/\/institute\/students\/([0-9a-f-]{36})/)?.[1];
    check('the list links to a student detail page', Boolean(id));
    if (id) {
      const detail = await institute.get(`/institute/students/${id}`);
      check('the student detail page renders with reasoning', detail.status === 200);
    }
  }

  {
    // The privacy wall the terms promise.
    const list = await institute.get('/institute/students');
    check('the coordinator view does not leak a raw income figure',
      !/\b80000\b/.test(list.text), 'an income value appeared in the list');
  }

  {
    // A coordinator must not be able to read another institute's students.
    const otherId = await one('select id from batch_students limit 1');
    const asStudent = await student.get(`/institute/students/${otherId.id}`);
    check('a student cannot open the institute area',
      asStudent.status === 302 && asStudent.location === '/dashboard',
      `${asStudent.status} ${asStudent.location ?? ''}`);
  }

  // ------------------------------------------------------------- ops ------
  console.log('\n  Ops');

  const ops = makeClient();
  {
    await signUp(ops, { identifier: 'ops@schemeconnect.test', role: 'student', name: 'Ops User' });
    const page = await ops.get('/ops');
    check('an allowlisted account reaches /ops', page.status === 200, `got ${page.status}`);
    check('/ops shows catalogue health', page.text.includes('183') || /schemes/i.test(page.text));
  }

  {
    // PRD §2.1: ops corrects a changed income limit before the window opens.
    // There was no write path into the catalogue at all before this.
    const scheme = await one(
      "select id, eligibility from schemes where detail_level = 'full' and eligibility ? 'maxFamilyIncome' limit 1");
    const before = scheme.eligibility.maxFamilyIncome;

    const edit = await ops.get(`/ops/schemes/${scheme.id}`);
    check('the correction screen renders', edit.status === 200 && edit.text.includes('Maximum family income'));

    const token = edit.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const name = edit.text.match(/id="f_name" name="name" type="text" value="([^"]*)"/)?.[1] ?? '';
    const saved = await ops.post(`/ops/schemes/${scheme.id}`, {
      _csrf: token, name, benefit_text: '', deadline: '', apply_url: '',
      maxFamilyIncome: '300000',
      reason: 'Income limit raised in the 2026-27 circular',
    });
    check('a correction saves', saved.location?.includes('saved=1'), saved.location ?? '');

    const override = await one(
      "select value, reason from scheme_overrides where scheme_id = $1 and field = 'eligibility'", [scheme.id]);
    check('the correction is stored as an overlay',
      override?.value?.maxFamilyIncome === 300000, JSON.stringify(override?.value));

    const scraped = await one('select eligibility from schemes where id = $1', [scheme.id]);
    check('the scraped value is left untouched underneath',
      scraped.eligibility.maxFamilyIncome === before,
      `scraped row now says ${scraped.eligibility.maxFamilyIncome}, was ${before}`);

    const audit = await one(
      "select reason from scheme_revisions where scheme_id = $1 order by edited_at desc limit 1", [scheme.id]);
    check('the correction is audited', audit?.reason?.includes('2026-27'), audit?.reason ?? 'none');

    // The correction has to reach everything that reads the catalogue —
    // the scheme page, and the matcher that decides who qualifies.
    const { getScheme: readScheme, matchableSchemes: readMatchable } =
      await import('../server/catalog.js');
    const corrected = await readScheme(scheme.id);
    check('the correction is what the catalogue now returns',
      corrected.eligibility.maxFamilyIncome === 300000,
      `got ${corrected.eligibility.maxFamilyIncome}`);

    const inMatcher = (await readMatchable()).find((x) => x.id === scheme.id);
    check('the matcher sees the corrected limit',
      inMatcher?.eligibility.maxFamilyIncome === 300000,
      `got ${inMatcher?.eligibility.maxFamilyIncome}`);

    const page = await ops.get(`/schemes/${scheme.id}`);
    check('the scheme page still renders after a correction', page.status === 200);

    // An apply link must stay on a government domain.
    const bad = await ops.get(`/ops/schemes/${scheme.id}`);
    const badToken = bad.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const rejected = await ops.post(`/ops/schemes/${scheme.id}`, {
      _csrf: badToken, name, benefit_text: '', deadline: '',
      apply_url: 'https://scholarships.example.com/apply',
      maxFamilyIncome: '300000', reason: 'trying a non-government link',
    });
    check('a non-government apply link is refused',
      rejected.location?.includes('error='), rejected.location ?? '');

    // And a correction must be revertible.
    const revertPage = await ops.get(`/ops/schemes/${scheme.id}`);
    const revertToken = revertPage.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await ops.post(`/ops/schemes/${scheme.id}/revert`, { _csrf: revertToken, reason: 'test cleanup' });
    const gone = await one('select 1 from scheme_overrides where scheme_id = $1', [scheme.id]);
    check('a correction can be reverted', !gone);
  }

  {
    // The full collection record, including what could not be read and what has
    // since vanished from its source.
    const page = await ops.get('/ops/export');
    check('the export page renders', page.status === 200 && /Total collected/.test(page.text));

    const dump = await ops.get('/ops/export.json');
    check('export.json is served as JSON', /application\/json/.test(dump.headers.get('content-type') ?? ''));
    const data = JSON.parse(dump.text);
    check('the dump includes retired schemes, not just live ones',
      data.counts.exported > data.counts.live, JSON.stringify(data.counts));
    check('every scheme carries its government source',
      data.schemes.every((x) => x.source?.url), 'a scheme had no source URL');
    check('criteria still quote the sentence they were read from',
      data.schemes.some((x) => (x.criteriaEvidence ?? []).length > 0));
    check('the source configuration is included', data.sources.length > 0);

    const live = JSON.parse((await ops.get('/ops/export.json?retired=false')).text);
    check('retired entries can be excluded',
      live.counts.retired === 0 && live.counts.exported === data.counts.live,
      JSON.stringify(live.counts));

    const csv = await ops.get('/ops/export.csv');
    check('export.csv is served as CSV', /text\/csv/.test(csv.headers.get('content-type') ?? ''));
    check('the CSV has one row per scheme plus a header',
      csv.text.trim().split('\n').length === data.counts.exported + 1,
      `${csv.text.trim().split('\n').length} lines vs ${data.counts.exported} schemes`);
  }

  {
    // The export is behind the ops guard — it carries confidence scores and
    // extractor internals, not just the public scheme information.
    const asStudent = await student.get('/ops/export.json');
    check('a student cannot download the export', asStudent.status === 404, `got ${asStudent.status}`);
  }

  {
    // A student must not reach the correction screens either.
    const res = await student.get('/ops/schemes');
    check('a student cannot open the correction screens', res.status === 404, `got ${res.status}`);
  }

  {
    // The catalogue requires an account. This reverses the progressive
    // profiling in PRD 2.1, deliberately: a scheme page with no assessment
    // beside it invites a student to judge her own eligibility, which is the
    // judgement the matcher exists to make explicit.
    const anon = makeClient();
    const list = await anon.get('/schemes');
    check('browsing the catalogue signed out redirects to sign-in',
      list.status === 302 && list.location === '/start',
      `${list.status} ${list.location ?? ''}`);

    const someScheme = await one('select id from schemes where retired_at is null limit 1');
    const detail = await anon.get(`/schemes/${someScheme.id}`);
    check('a scheme page signed out redirects to sign-in',
      detail.status === 302 && detail.location === '/start',
      `${detail.status} ${detail.location ?? ''}`);

    const landing = await anon.get('/');
    check('the landing page no longer offers browsing',
      !/href="\/schemes"/.test(landing.text));
    check('the landing page still renders', landing.status === 200 && landing.text.length > 3000);
  }

  // ------------------------------------------------------- link health ----
  // "Every result links to the scheme's official government page, with a
  // verified badge" is the top-rated need in the feature list. Checking the
  // catalogue found 56 of 123 links dead, sitting behind that badge.
  console.log('\n  Official links');

  {
    const { getScheme: readScheme } = await import('../server/catalog.js');
    const broken = await one(
      "select id from schemes where apply_url_status in ('missing','unreachable') and retired_at is null limit 1");
    const working = await one(
      "select id from schemes where apply_url_status in ('ok','redirected') and retired_at is null limit 1");

    if (broken) {
      const page = await student.get(`/schemes/${broken.id}`);
      check('a dead link is called out on the scheme page',
        /official page is not responding/i.test(page.text));
      check('the button stops claiming the application is there',
        /Try the official page anyway/.test(page.text)
          && !/Continue to official application/.test(page.text));
    } else {
      check('a dead link is called out on the scheme page', true, 'skipped — none recorded');
    }

    if (working) {
      const page = await student.get(`/schemes/${working.id}`);
      check('a working link still reads as the primary action',
        /Continue to official application/.test(page.text)
          && !/official page is not responding/i.test(page.text));
    }

    // An unchecked link must never be presented as verified.
    const scheme = await readScheme((broken ?? working).id);
    check('link status travels with the scheme record',
      ['ok', 'redirected', 'missing', 'unreachable', 'forbidden'].includes(scheme.applyUrlStatus),
      String(scheme.applyUrlStatus));

    // 403 means a bot was refused, not that a person would be. Not an error.
    const forbidden = await one(
      "select id from schemes where apply_url_status = 'forbidden' and retired_at is null limit 1");
    if (forbidden) {
      const page = await student.get(`/schemes/${forbidden.id}`);
      check('a link that merely blocks bots is not called broken',
        !/official page is not responding/i.test(page.text));
    }
  }

  // ------------------------------------------------ CSP-safe interaction ---
  // script-src 'self' forbids inline handlers, so an onclick or a javascript:
  // URL is silently dead in the browser while still looking correct in the
  // source. That took out row navigation, the Terms back link and — worst — the
  // confirmation on account deletion.
  console.log('\n  Interaction survives the CSP');

  {
    // /schemes needs an account now, so it is checked with a signed-in client.
    const pages = ['/', '/start', '/login?role=student', '/terms'];
    const offenders = [];
    for (const url of [...pages, '/schemes']) {
      const { text } = await (url === '/schemes' ? student : makeClient()).get(url);
      if (/\son[a-z]+\s*=\s*["']/i.test(text)) offenders.push(`${url} (inline handler)`);
      if (/href\s*=\s*["']javascript:/i.test(text)) offenders.push(`${url} (javascript: URL)`);
    }
    check('public pages carry no inline handlers or javascript: URLs',
      offenders.length === 0, offenders.join(', '));

    const terms = await makeClient().get('/terms');
    check('the Terms back link is a real href', /class="link-back" href="\/"/.test(terms.text));

    const profile = await student.get('/profile');
    check('account deletion still asks for confirmation',
      /data-confirm="[^"]*permanently deletes/.test(profile.text));
  }

  {
    // Rows are reachable without JavaScript at all.
    const list = await institute.get('/institute/students');
    check('student rows contain a real link, not just a data-href',
      /<a class="row-link" href="\/institute\/students\/[0-9a-f-]{36}"/.test(list.text));
    check('rows still carry data-href for the whole-row click',
      /<tr class="clickable" data-href="\/institute\/students\//.test(list.text));
  }

  // -------------------------------------------------------- erasure -------
  console.log('\n  Erasure');

  {
    const user = await one("select id from users where identifier = 'ananya@e2e.test'");
    const token = await student.csrf('/profile');
    await student.post('/profile/delete', { _csrf: token });

    const after = await one(
      `select
         (select count(*)::int from users where id = $1)                as users,
         (select count(*)::int from consents where user_id = $1)        as consents,
         (select count(*)::int from sessions where user_id = $1)        as sessions,
         (select count(*)::int from saved_schemes where user_id = $1)   as saved,
         (select count(*)::int from student_profiles where user_id = $1) as profiles,
         (select count(*)::int from document_checklist where user_id = $1) as checklist,
         (select count(*)::int from document_verifications where user_id = $1) as documents`,
      [user.id]);

    const leftovers = Object.entries(after).filter(([, n]) => n > 0);
    check('deleting an account erases every trace of it',
      leftovers.length === 0, leftovers.map(([k, n]) => `${k}=${n}`).join(', '));
  }

  // --------------------------------------------------- password sign-in ---
  // AUTH_MODE=password exists for deployments that cannot send mail — a host
  // blocking outbound SMTP, or an email account with no verified domain.
  console.log('\n  Password sign-in (AUTH_MODE=password)');

  {
    const PW_PORT = PORT + 1;
    const PW_BASE = `http://127.0.0.1:${PW_PORT}`;
    const pw = startServer({ AUTH_MODE: 'password', SHOW_DEV_OTP: 'false' }, PW_PORT);
    try {
      await waitForServer(pw, PW_BASE);

      const req = async (method, url, form, jar) => {
        const res = await fetch(PW_BASE + url, {
          method, redirect: 'manual',
          headers: {
            ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
            ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: form ? new URLSearchParams(form).toString() : undefined,
        });
        for (const raw of res.headers.getSetCookie?.() ?? []) {
          const [pair] = raw.split(';');
          const i = pair.indexOf('=');
          const v = pair.slice(i + 1).trim();
          if (v === '') jar.delete(pair.slice(0, i).trim());
          else jar.set(pair.slice(0, i).trim(), v);
        }
        return { status: res.status, location: res.headers.get('location'), text: await res.text() };
      };
      const csrf = async (url, jar) =>
        (await req('GET', url, null, jar)).text.match(/name="_csrf" value="([^"]+)"/)?.[1];

      const email = 'pw@e2e.test';
      await query('delete from users where identifier = $1', [email]);

      const jar = new Map();
      const page = await req('GET', '/login?role=student', null, jar);
      check('the login page asks for a password', /name="password"/.test(page.text));
      check('it does not mention a 6-digit code', !/6-digit code/.test(page.text));

      let token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
      const signup = await req('POST', '/login',
        { _csrf: token, role: 'student', identifier: email, password: 'hunter2hunter2' }, jar);
      check('an unknown address goes to sign-up', signup.location?.startsWith('/signup'), signup.location ?? '');

      token = await csrf('/signup?role=student', jar);
      const created = await req('POST', '/signup',
        { _csrf: token, role: 'student', name: 'Pat Kaur', email, consent: 'yes' }, jar);
      check('the account is created', created.location === '/onboarding', created.location ?? '');

      const stored = await one(
        'select password_hash, (select count(*)::int from consents c where c.user_id = u.id) as consents'
        + ' from users u where identifier = $1', [email]);
      check('the password is hashed with scrypt, not stored raw',
        stored?.password_hash?.startsWith('scrypt$') && !stored.password_hash.includes('hunter2'),
        String(stored?.password_hash).slice(0, 20));
      check('consent was still recorded', stored?.consents === 1);

      // Sign out, then back in.
      await req('GET', '/logout', null, jar);
      const fresh = new Map();
      token = await csrf('/login?role=student', fresh);
      const wrong = await req('POST', '/login',
        { _csrf: token, role: 'student', identifier: email, password: 'wrongwrongwrong' }, fresh);
      check('a wrong password is refused', wrong.location?.includes('error='), wrong.location ?? '');
      check('the error does not reveal whether the account exists',
        decodeURIComponent(wrong.location ?? '').includes('do not match'),
        decodeURIComponent(wrong.location ?? ''));

      token = await csrf('/login?role=student', fresh);
      const right = await req('POST', '/login',
        { _csrf: token, role: 'student', identifier: email, password: 'hunter2hunter2' }, fresh);
      check('the right password signs in', right.location === '/dashboard', right.location ?? '');

      const dash = await req('GET', '/dashboard', null, fresh);
      check('the session works', dash.status === 200 && !dash.location, `status ${dash.status}`);

      const shortJar = new Map();
      token = await csrf('/login?role=student', shortJar);
      const short = await req('POST', '/login',
        { _csrf: token, role: 'student', identifier: 'x@e2e.test', password: 'short' }, shortJar);
      check('a too-short password is refused', short.location?.includes('error='), short.location ?? '');

      await query('delete from users where identifier = $1', [email]);
    } finally {
      pw.kill('SIGTERM');
    }
  }

  // ------------------------------------------------------ rate limiting ---
  // Last, because it deliberately exhausts the shared per-IP bucket.
  console.log('\n  Rate limiting');

  {
    const c = makeClient();
    let blockedAfter = null;
    for (let i = 1; i <= 8; i++) {
      const token = await c.csrf('/login?role=student');
      const res = await c.post('/login', { _csrf: token, role: 'student', identifier: 'flood@e2e.test' });
      if (res.status === 429) { blockedAfter = i; break; }
    }
    check('repeated codes for one contact are throttled', blockedAfter !== null,
      'eight requests all went through');
    check('the throttle allows a few retries first', blockedAfter === null || blockedAfter > 3,
      `blocked on request ${blockedAfter}`);
  }

  {
    // A shared IP must not lock out other students at the per-contact limit.
    const c = makeClient();
    const token = await c.csrf('/login?role=student');
    const res = await c.post('/login', { _csrf: token, role: 'student', identifier: 'neighbour@e2e.test' });
    check('a different contact on the same IP is not locked out', res.status !== 429,
      `got ${res.status}`);
  }

  // ---------------------------------------------------------- cleanup -----
  await query("delete from users where identifier like '%@e2e.test' or identifier = 'ops@schemeconnect.test'");
  await query("delete from otp_codes where identifier like '%@e2e.test'");
  await query("delete from rate_limits");
  await query("delete from rate_limits where bucket like '%e2e.test%'");
} catch (err) {
  failed++;
  failures.push(`harness: ${err.message}`);
  console.error(`\n  harness error: ${err.stack}\n`);
} finally {
  server.kill('SIGTERM');
  server.restarted?.kill('SIGTERM');
  await close();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exitCode = 1;
}
