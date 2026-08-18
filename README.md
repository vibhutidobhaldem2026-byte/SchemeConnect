# SchemeConnect

A discovery and trust layer for Indian government scholarships, built from the
approved wireframe and the PRD v2.1. **Every scheme on the site is produced by
the bundled scraper** — nothing in the catalogue is hand-authored. If the
scraper has never run, the site says so rather than showing invented content.

```bash
cd backend
npm install
cp .env.example .env      # set DATABASE_URL, DIRECT_URL and SESSION_SECRET
npm run setup             # migrate, then load the bundled catalogue
npm start                 # http://localhost:3000
```

The repository is in three parts:

```
backend/     the Express app, eligibility engine, scraper and schema  → Render
frontend/    the CSS, JS and favicon the backend serves                 (no build)
docs/        the PRD, MVP feature list and approved wireframes
```

`frontend/` is **not** deployed separately. Pages are rendered on the server, so
the assets belong on the same origin as the HTML that references them — a second
host would cost an extra DNS lookup and TLS handshake for 20 KB and buy nothing
on the 2G/3G connections PRD §4 targets. `render.yaml` deploys the whole thing as
one service.

The server also binds to your LAN, so it prints a second URL
(`http://192.168.x.x:3000`) you can open on a phone on the same wifi.

`npm run setup` is `npm run migrate && npm run import:catalog`. Run
`npm run scrape` when you want fresh data from the government sources; it
publishes straight to the database.

---

## Storage

Everything persists in **PostgreSQL** — accounts, consent records, sessions,
institute batches, and the scheme catalogue itself.

Earlier versions kept application data in a single JSON file and the catalogue
in a committed JSON file. That could not be deployed: two instances overwrote
each other, a failed write was logged and swallowed while the caller was told
it had succeeded, and on any ephemeral filesystem — Render, Railway, Fly, Cloud
Run — every deploy wiped every account. The server now refuses to start without
`DATABASE_URL` rather than falling back to something that silently forgets.

Three guarantees are enforced by the schema rather than by application code,
because code is where they were being missed:

- **Erasure is complete.** Every table referencing a user cascades, so "delete
  my account and data" is one statement. The hand-written version missed the
  user's sessions and their institute rows.
- **Consent cannot be orphaned.** An account and its consent record are written
  in one transaction, and a self-declared minor without guardian details is
  rejected by a check constraint.
- **An unread criterion is never a pass.** A scheme may only be marked
  matchable if it actually carries eligibility criteria.

### Hosted PostgreSQL

Runs on **Supabase, `ap-south-1` (Mumbai)** — the closest region to the students
this is for. Managed providers give you two endpoints; point `DATABASE_URL` at
the pooled one and `DIRECT_URL` at the session/direct one. Migrations and the
catalogue import prefer `DIRECT_URL`, because DDL and bulk loads want a real
session rather than a transaction-mode pooler.

```
DATABASE_URL=postgresql://…@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
DIRECT_URL=postgresql://…@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

Two things to know about connecting to Supabase specifically:

- **Its direct host (`db.*.supabase.co`) is IPv6-only.** It publishes an AAAA
  record and no A record, so it is unreachable from an IPv4-only network. Use
  the **session pooler** on port 5432 as the direct endpoint instead — same
  thing, over IPv4, no paid add-on needed.
- **Its certificates come from Supabase's own CA**, not a publicly trusted one,
  so Node rejects them by default. Download the certificate from Project
  Settings → Database → SSL Configuration and set `PGSSL_CA_FILE=certs/prod-ca-2021.crt`.
  `PGSSL_NO_VERIFY=true` gets you running without it — encrypted but unverified
  — and the server prints a warning on every boot while it is set.

TLS is configured entirely in `db.js`. Any `sslmode` in the connection string is
stripped before it reaches the driver, because node-postgres derives its own ssl
settings from `sslmode` and those silently win over a pinned CA.

**Region matters more than it looks.** Every page is a small number of database
round trips, so the distance between app server and database sets the floor on
page latency, and PRD §4 asks for results within two seconds on 3G. Measured
from India, rendering `/schemes`:

| Database region | Round trip | `/schemes` | Catalogue load |
| --- | --- | --- | --- |
| `us-east-2` (Ohio) | 250 ms | 268 ms | 9 s |
| `ap-southeast-1` (Singapore) | 62 ms | 123 ms | 4.6 s |
| `ap-south-1` (Mumbai) | 37 ms | **47 ms** | **2.9 s** |

Put the app server in the same region as the database; then only one user→server
hop is left.

**On scale-to-zero.** Neon suspends an idle compute after five minutes on every
plan, including paid — measured cold start was 468 ms on the first query, which
on a low-traffic pilot is most visitors. Its free tier caps compute at 100
CU-hours a month against the ~730 a month contains, so keeping one awake is not
an option there. Supabase instead pauses a free project only after a **week** of
inactivity, with no compute-hour meter, which is why it is the better fit here.
`KEEPWARM_MINUTES` exists for providers that need it and is off by default.

The pool assumes the database may vanish underneath it. Idle connections are
recycled after ten seconds, and a **read** that fails on a dropped connection is
retried once. Writes are never retried: a reset after an insert leaves us unable
to tell whether it committed, and a duplicate consent record is worse than an
error.

### Migrations

Plain `.sql` files in `migrations/`, applied in filename order, each in its own
transaction and recorded in `schema_migrations`. Editing an already-applied
migration is an error rather than a silent no-op — that is how two environments
quietly stop matching.

```bash
npm run migrate          # apply everything outstanding
npm run migrate:status   # what is applied, what is pending
```

### Ops can correct a scheme

PRD §2.1 asks for an ops member to update a changed income limit before an
application window opens. `/ops/schemes` does that now; it used to mean editing
a JSON file, committing and redeploying.

A correction is an **overlay**, never an overwrite. The scraped row and its
provenance stay intact underneath, the change carries a reason and a timestamp,
every edit is audited in `scheme_revisions`, and any correction can be reverted.

---

## Security

Four defects were fixed alongside the migration. Each has an end-to-end test
that fails if the fix is reverted.

- **Sign-up bypassed OTP verification.** The verified identifier was carried to
  the sign-up screen in an unsigned `sc_pending` cookie which the server took at
  face value. A hand-written `Cookie` header created a fully verified account on
  any address without ever receiving a code. Verification now opens a
  time-limited window on the OTP row, and sign-up reads that.
- **`/ops` had no authentication.** Anyone could read user counts, minor-consent
  counts and the source configuration. Access now needs the `ops` role or an
  `OPS_EMAILS` entry, and a non-ops visitor gets a 404, not a 403.
- **No CSRF protection.** Every mutation was a cookie-authenticated form POST
  with no token, so a page a student visited could submit `POST /profile/delete`.
  Signed double-submit tokens are now injected into every rendered form
  centrally, so a new form cannot be forgotten — it fails closed instead.
- **OTP issuance was unthrottled**, and codes were stored in plaintext. Codes
  are hashed now, and issuance is limited per contact and — much more loosely —
  per IP, since a school computer room is many legitimate students behind one
  address.

Cookies are marked `Secure` when `NODE_ENV=production`, sessions expire
server-side rather than trusting the cookie's max-age, and expired OTPs,
sessions and rate-limit windows are swept hourly.

---

## Email OTP (Resend)

Configured in `.env`, loaded by Node's built-in env loader — no `dotenv`
dependency. The key is read from the environment, never hardcoded, and is
redacted from any error text before it can reach a log line or an error page.

```ini
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM=SchemeConnect <onboarding@resend.dev>
SHOW_DEV_OTP=true     # also show the code on screen while testing
```

Send a real test email:

```bash
npm run test:email -- you@example.com
```

### How delivery is reported

The verify screen states what actually happened rather than always claiming a
message is on its way:

| Identifier | Behaviour |
|---|---|
| Email, sent OK | Green "Code sent to …", names the sender, mentions spam folder |
| Email, send failed | Amber warning with **Resend's own error text**, plus the code on screen so testing isn't blocked |
| Mobile | States plainly that no SMS provider is configured, shows the code |

A failed send never blocks sign-in — the code stays valid and is displayed.

### Sending domain

`RESEND_FROM` points at `schemeconnect.com`. **Adding a domain in Resend is not
the same as verifying it** — until its DNS records are in place Resend rejects
every send from it:

```
The schemeconnect.com domain is not verified.
```

Rather than letting every OTP fail during DNS propagation, that specific error
triggers one retry from `RESEND_FROM_FALLBACK` (Resend's shared sender). Sign-in
keeps working, the fallback is logged loudly, and the moment verification passes
the configured domain takes over on its own — no code or config change.

While the fallback is in use, Resend's sandbox limits apply again: delivery only
to the address the Resend account is registered with. `delivered@resend.dev`
always works for testing.

The verify screen names the address the mail **actually came from**, not the
configured one, so a user is never told to look for a sender that didn't send.

To finish verification: open <https://resend.com/domains>, copy the SPF, DKIM
and MX records Resend shows for `schemeconnect.com` into your DNS provider, then
click Verify. Nothing in the app needs changing afterwards.

### Student sign-in accepts email *or* mobile

The PRD is mobile-first, but only email can actually be delivered right now, so
the student login accepts either. Sign in with an email and the code really
arrives; sign in with a mobile and it is shown on screen. A student who signs
in by email is not asked for their email again at sign-up — it is already
verified.

Set `SHOW_DEV_OTP=false` before any real pilot, so a successfully delivered
code is never also printed on screen.

---

## The scraper

### Government-only, enforced in three places

The hard requirement is that the scraper only ever touches Indian government
websites. That is enforced at three levels, not one:

1. **Static check before any network activity** — `npm run verify:sources`
   (also run automatically at the start of every crawl). A single
   non-government source aborts the run.
2. **Per-request guard** — every fetch calls `assertAllowed()`, which *throws*
   rather than skipping. A silent skip would let a misconfigured source quietly
   widen the crawl.
3. **Post-redirect re-check** — a redirect that lands off a government domain is
   rejected after the fact.

Policy: **https only, host must end in `.gov.in` or `.nic.in`**, minus an
explicit host/path denylist (login pages, payment gateways, DigiLocker/UIDAI).

This is deliberately strict. AICTE, for example, is a statutory body with rich
scholarship data, but sits on `aicte-india.org` — so it is excluded and the
reason is recorded in `config/sources.js`.

### Politeness

- `robots.txt` fetched, parsed and honoured per origin, following RFC 9309:
  2xx applies the rules, 4xx means no rules exist, 5xx means full disallow.
- Requests to a single host are **serialised** — never parallel — with a
  minimum 2s gap, raised automatically if the host declares a `Crawl-delay`.
- Honest, identifying `User-Agent` with a contact address.
- Exponential backoff on 429/5xx; on-disk response cache so repeated
  development runs do not re-hit government servers.

We do not spoof a browser User-Agent to get past a bot block, and we do not
disable TLS verification to get past a broken certificate chain. Both would
work; both are the wrong thing to do to a government server.

### Two-tier catalogue

Government sites publish scheme **listings** readily, but eligibility **detail**
lives in PDF circulars and detail pages that are often unreachable. So a scheme
lands in one of two tiers:

| Tier | What we have | Appears in browse | Enters matching |
|---|---|---|---|
| `full` | Criteria parsed from the source | Yes | **Yes** |
| `listing` | Authoritative name + official link only | Yes, clearly flagged | **No** |

A listing-only scheme is never matched against a student, because absence of
criteria must never be read as "you qualify". This is the same reasoning as the
PRD's rule about uncovered states.

### Provenance and honesty

Every extracted criterion carries **the sentence it came from**, shown to the
user on the scheme page. Criteria are parsed from prose by pattern matching,
not read by a human, so the product shows its working rather than asking to be
trusted. Each scheme also carries its source URL, adapter, fetch timestamp and
a confidence score (the share of six signals the parser could read).

The matcher never treats an unknown as a pass. A criterion the scraper could
not read is reported as unknown and shown with a `?`.

### Commands

```bash
npm run scrape                      # full crawl, writes data/catalog/
npm run scrape -- --dry-run         # crawl and report, write nothing
npm run scrape -- --source nsp-home # one source (may target a disabled one)
npm run scrape -- --limit 5         # cap candidates per source
npm run scrape -- --no-cache        # ignore the on-disk cache
npm run verify:sources              # static allowlist check, no network
node scraper/probe.js               # reachability report for every source
node scraper/inspect.js <url>       # dump what the scraper sees on one page
```

### Outputs

| File | Contents |
|---|---|
| `data/catalog/schemes.json` | The catalogue the website reads |
| `data/catalog/coverage.json` | Which states can and cannot be served |
| `data/catalog/scrape-runs.json` | Run history, failures and rejections |

A crawl that returns zero schemes **does not** overwrite a good catalogue — the
site keeps serving the last known-good data, flagged as stale.

---

## Source health

Twelve government sources are configured; five are currently reachable. The
rest stay in `config/sources.js` with a recorded reason rather than being
deleted, and `node scraper/probe.js` re-tests them all.

**Active:** `dbtbharat.gov.in`, `scholarships.gov.in`, `socialjustice.gov.in`,
`ugc.gov.in`, `directorateofhighereducation.assam.gov.in`

**Disabled — incomplete TLS chain** (the department needs to serve its
intermediate certificate): `tribal.nic.in`, `minorityaffairs.gov.in`,
`online-inspire.gov.in`, `scholarship.up.gov.in`, `swd.kerala.gov.in`

**Disabled — HTTP 403 to non-browser agents:** `education.gov.in`,
`dsel.education.gov.in`

This matters for coverage: ST-specific scholarships live largely on
`tribal.nic.in`, so a Scheduled Tribe student currently gets few matches. The
product tells them that explicitly instead of implying they are ineligible.

---

## The website

Server-rendered Express. One runtime dependency (`express`); no build step. The
design system is carried over from the approved wireframe.

### Screens

**Public** — landing, role select, Terms & Conditions, full scheme catalogue
with search and filters, scheme detail (readable signed out).

**Student** — OTP login, sign-up with the Terms gate, six-question guided form
(one question per screen, saved on every step), matched results with "why you
matched", near-misses with reason codes, scheme detail with provenance, saved,
applied, profile, optional document verification.

**Institute** — OTP login, sign-up with the authorised-signatory gate, welcome,
overview, batch upload (**.xlsx or .csv**) with auto column mapping, import
preview, student list with search, consent-gated student detail.

### Batch upload formats

Excel `.xlsx` and `.csv` are both accepted. The `.xlsx` reader in
`server/xlsx.js` is written from scratch against the OOXML spec — an `.xlsx` is
a ZIP of XML parts and Node ships `zlib`, so it needs no dependency. That
matters for a file arriving from an institute: the popular spreadsheet
libraries are large and have a poor CVE record for parsing untrusted input.

It reads the ZIP central directory (including ZIP64), inflates the parts,
resolves the shared-string table, and handles rich-text runs, inline strings
and sparse rows. It deliberately does **not** convert Excel serial dates —
none of the imported columns are dates, and a wrong guess would turn a roll
number into one.

Generate a sample file to test with:

```bash
node scripts/make-sample-xlsx.js sample-batch.xlsx
```

Old binary `.xls` is not supported; the UI says so and asks for a re-save.

**Ops** (`/ops`) — catalogue health, extraction confidence, state coverage
gaps, source status, scrape run history and the rejection list from the last
run.

### Consent and the DPDP Act

The PRD notes that a large share of users are under 18, and requires
compliance with the Digital Personal Data Protection Act 2023. So:

- The Terms checkbox is **enforced server-side**. The disabled button is an
  affordance; `routes/auth.js` is what actually refuses to create the account.
- A student who declares they are under 18 cannot proceed without a parent or
  guardian's name and contact, recorded as the consent record.
- Institutes must confirm they hold verifiable parental consent before
  uploading data for any student under 18. That obligation is stated at
  sign-up, restated at upload, and written into Terms section 10.
- Acceptance is stored with a **terms version**, so section 15's promise to
  re-ask on material change is actually enforceable.

### What an institute can see

A coordinator sees the student details **their own institute uploaded** —
class, state, category, income, gender — alongside each student's matched
schemes, the reason for each match, and the near-misses. That is the point of
the coordinator view: a match count alone can't be acted on.

The line that remains is **origin, not visibility**:

| Data | Institute sees it? |
|---|---|
| Details the institute uploaded in a batch | Yes |
| Match results derived from those details | Yes |
| Documents a student uploads on their own account | No |
| Details a student enters or corrects themselves | No |

The reasoning: an institute already holds the data it uploaded, so showing it
back discloses nothing new. What a student adds privately is a different
matter, and stays theirs.

This is stated in Terms sections 10 and 11, and the split is verified by the
test suite — including a check that the Terms no longer claim a consent gate
that the product does not enforce.

---

## Tests

```bash
npm run test:all      # extraction heuristics, matcher sanity, full journeys
npm test              # extraction heuristics only (no database needed)
npm run test:e2e      # boots the app and drives it over real HTTP
```

`test:e2e` covers both journeys end to end, persistence across a server
restart, complete erasure on account deletion, the ops correction overlay, and
a regression test for each security defect listed above.


```bash
node scripts/test-extract.js     # 27 unit tests for the extraction heuristics
node scripts/check-matching.js   # matcher sanity check against the real catalogue
```

The extractor tests pin the rules that decide whether a real student is shown
or denied a scheme. The negative cases matter most — a false restriction
silently hides a scheme someone qualifies for. Two examples both caught by
these tests during development:

- *"30% of the scholarships are earmarked for female candidates"* is a **quota
  within an open scheme**, not a women-only restriction. Reading it as one
  excluded every male SC applicant from the National Overseas Scholarship.
- The sentence splitter broke on `"Rs."`, severing *"income should not exceed
  Rs. 2,50,000"* in half and silently dropping every income ceiling written
  that way.

---

## Layout

```
backend/
  config/           sources (incl. disabled ones, with reasons), paths
  migrations/       001_catalog.sql, 002_app.sql
  certs/            the provider's public CA, so TLS is verified not just encrypted
  data/catalog/     scraper export — seeds a fresh database, not read at runtime
  scraper/
    run.js          CLI orchestrator
    publish.js      writes a crawl into PostgreSQL
    adapters/       govHtml (listings + detail), govPdf (circulars)
    lib/            allowlist, robots, httpClient, cache, html, pdf,
                    extract (heuristics), normalize (schema + validation)
  server/
    index.js        app wiring, preflight checks, /healthz
    db.js           pool, transactions, TLS, batched inserts
    store.js        accounts, consent, activity, batches
    catalog.js      the scheme catalogue, plus ops corrections
    security.js     CSRF, rate limiting, headers
    matcher.js      eligibility engine, reason codes
    csv.js / xlsx.js  batch parsing + column mapping
    terms.js        versioned Terms content
    render.js       escaping-by-default templating
    routes/         public, auth, student, institute, ops
  scripts/
    migrate.js      SQL migration runner
    import-catalog.js  seeds the catalogue from the export
    test-e2e.js     full journeys + security regressions
frontend/
  css/app.css       served by the backend, same origin
  js/app.js         progressive enhancement only
docs/               PRD v2.1, MVP feature list, wireframes
render.yaml         one web service, migrations run before traffic
```

---

## Known limits

- **Email OTP is live via Resend; SMS is not.** Mobile codes are shown on
  screen. Wire up an SMS provider (MSG91, Twilio) before a mobile-first pilot.
- **Resend needs a verified domain** to email anyone other than the Resend
  account owner. Until then use `delivered@resend.dev` for testing.
- **Document upload does not store files.** The flow records that a document
  was submitted and says so — it no longer claims "Verified" for a file nobody
  looked at. Real handling needs object storage, encryption and a retention
  policy; the `document_verifications` table already carries `storage_key` and
  `purge_after` for it.
- **No scheme publishes an application deadline.** Checked directly: the
  central guideline pages carry dates, but never deadline wording — these
  documents describe a scheme, while the application window lives on the
  National Scholarship Portal and changes each academic year. The extractor is
  deliberately *not* loosened to read those stray dates as deadlines; inventing
  one would be worse than having none. The engine refuses to match a scheme
  whose window has shut, so the guarantee is in place for when the data is.
- **Only 17 of 123 official links are confirmed reachable.** Checking every one
  found 28 returning 4xx and 28 whose host does not respond at all — one
  ministry domain has no DNS record, taking seven scholarships with it. Those
  schemes now say so on their page instead of sitting behind a verified badge.
  A further 50 refuse automated checks with a 403; those are almost certainly
  fine in a browser and are not called broken. `npm run check:links` refreshes
  this, and `/ops/export` shows the breakdown.
- **9 of 123 schemes have machine-readable criteria**, and coverage is central
  government plus one Assam entry. This is the real cap on the product's
  usefulness. The bottleneck is not the extractor — every page whose detail we
  could actually fetch produced criteria. It is source reachability: of 132
  candidate links, 34 sit behind a robots.txt we cannot read (host down, TLS
  chain incomplete, or timing out), 11 return 4xx, and most of the rest are
  ministry homepages rather than scheme pages. `/ops/runs` lists every rejection
  with its reason.
- **DBT Bharat is a poor source for this product** and should be replaced. It
  indexes all 320 central DBT schemes across 56 ministries — pensions, crop
  subsidies, vehicle incentives — of which only a fraction are scholarships, and
  its links usually point at a ministry homepage. The National Scholarship
  Portal's own per-scheme guideline PDFs are the better target.
  182 central to 1 state. This is the real cap on the product's usefulness and
  it is a scraper-coverage problem, not a storage one. The rejection list at
  `/ops/runs` shows exactly what failed and why.
- **No Hindi or regional languages.** PRD §3.1 makes language the first screen;
  there is no i18n layer yet.
- **No deadline reminders.** The next feature the database unlocks: a
  `reminders` table and a worker, reusing the existing Resend integration.
- **The guided form still requires an account.** PRD §2.1 wants a first
  eligibility check without one.
- **Terms are drafted for a pilot** and need legal review before launch.
