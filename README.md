# SchemeConnect

A discovery and trust layer for Indian government scholarships, built from the
approved wireframe and the PRD v2.1. **Every scheme on the site is produced by
the bundled scraper** — nothing in the catalogue is hand-authored. If the
scraper has never run, the site says so rather than showing invented content.

```bash
npm install
cp .env.example .env   # then fill in RESEND_API_KEY
npm run scrape         # populate the catalogue from government sources
npm start              # http://localhost:3000
```

The server also binds to your LAN, so it prints a second URL
(`http://192.168.x.x:3000`) you can open on a phone on the same wifi.

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
config/
  sources.js        government sources, incl. disabled ones with reasons
  paths.js
scraper/
  run.js            CLI orchestrator
  verify-sources.js static allowlist check
  probe.js          reachability report
  inspect.js        single-page debugger
  adapters/         govHtml (listings + detail), govPdf (circulars)
  lib/              allowlist, robots, httpClient, cache, html, pdf,
                    extract (heuristics), normalize (schema + validation)
server/
  index.js          app wiring
  catalog.js        reads scraper output — the only source of scheme data
  matcher.js        eligibility engine, reason codes
  csv.js            RFC-4180 CSV parser + column mapping
  terms.js          versioned Terms content
  render.js         escaping-by-default templating
  routes/           public, auth, student, institute, ops
public/             css + progressive-enhancement JS
data/               catalog output, app store, response cache
```

---

## Known limits

- **Email OTP is live via Resend; SMS is not.** Mobile codes are shown on
  screen. Wire up an SMS provider (MSG91, Twilio) before a mobile-first pilot.
- **Resend needs a verified domain** to email anyone other than the Resend
  account owner. Until then use `delivered@resend.dev` for testing.
- **Document upload does not store files.** The flow records verification state
  only. Real handling needs encrypted storage and a retention policy.
- **The app store is a JSON file.** Fine for a pilot, not for production
  concurrency.
- **10 of 183 schemes have machine-readable criteria.** The bottleneck is
  source reachability, not the parser — the rejection list at `/ops/runs` shows
  exactly what failed and why.
- **Terms are drafted for a pilot** and need legal review before launch.
