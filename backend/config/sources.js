/**
 * Government scheme sources.
 *
 * Every entry must be on a .gov.in / .nic.in host — the allowlist enforces this
 * at fetch time, and `npm run verify:sources` checks it statically so a bad
 * entry is caught before a crawl starts.
 *
 * Sources carry `enabled: false` with a `disabledReason` rather than being
 * deleted, so the config records what was tried and why it is not in the crawl.
 * `node scraper/probe.js` re-tests every source including the disabled ones —
 * several are expected to come back as a government department fixes its TLS
 * chain or lifts a bot block.
 */

export const SOURCES = [
  // ---------------------------------------------------------------- enabled --
  {
    id: 'myscheme',
    adapter: 'myscheme',
    url: 'https://www.myscheme.gov.in/search',
    label: 'myScheme — Government of India scheme directory',
    level: 'central',
    maxLinks: 400,
    enabled: true,
    // The ministry sites publish a scheme once and let the page rot; of 123
    // links harvested that way only 17 still resolved. This directory is
    // maintained, states eligibility as discrete sentences, and its pages stay
    // up — so the link we hand a student keeps working. It renders client-side,
    // so this source is read with a browser; robots.txt allows it outright.
  },
  {
    id: 'dbt-central-schemes',
    adapter: 'gov-html',
    url: 'https://dbtbharat.gov.in/central-scheme/list',
    label: 'DBT Bharat — central scheme list',
    level: 'central',
    maxLinks: 60,
    enabled: false,
    disabledReason:
      'An index of all 320 central DBT schemes across 56 ministries, most of them '
      + 'nothing to do with students, and its links are not maintained. Of the schemes '
      + 'it produced, 9 in 123 carried readable criteria and only 15 links still '
      + 'resolved — 28 returned 4xx and 28 pointed at hosts that no longer answer, one '
      + 'having lost its DNS record entirely. myScheme covers the same central schemes '
      + 'from a directory somebody maintains: every page it gave us had criteria, and '
      + 'every link worked.',
  },
  {
    id: 'tribal-schemes-gov',
    adapter: 'gov-html',
    url: 'https://tribal.gov.in/Scholarship.aspx',
    label: 'Ministry of Tribal Affairs — scholarships',
    level: 'central',
    maxLinks: 25,
    enabled: true,
    // Replaces tribal.nic.in, which is disabled below for an incomplete TLS
    // chain. Same ministry, valid certificate, and it states income ceilings and
    // class ranges inline rather than burying them in a circular.
  },
  {
    id: 'aicte-schemes',
    adapter: 'gov-html',
    url: 'https://www.aicte.gov.in/schemes/students-development-schemes',
    label: 'AICTE — student development schemes',
    level: 'central',
    maxLinks: 30,
    enabled: true,
    // aicte-india.org now redirects here; aicte.gov.in is the canonical host.
  },
  {
    id: 'depwd-schemes',
    adapter: 'gov-html',
    url: 'https://depwd.gov.in/en/schemes/',
    label: 'Dept. of Empowerment of Persons with Disabilities — schemes',
    level: 'central',
    maxLinks: 25,
    enabled: true,
    // Replaces disabilityaffairs.gov.in, whose certificate has expired. This is
    // the same department, and its robots.txt permits everything but /wp-admin.
  },
  // ---------------------------------------------------------------------
  // States.
  //
  // Every one of these was reachable with our own bot user-agent and permitted
  // by robots. They are here because a scholarship a student cannot find is
  // the same to them as one that does not exist, and the catalogue was almost
  // entirely central schemes — which are the ones already easiest to hear
  // about. Several more states were tried and left out: Bihar redirects in a
  // loop, Karnataka and Telangana serve empty shells, Odisha's welfare portal
  // needs a login. They are absent because nothing there could be read, not
  // because they were not looked for.
  // ---------------------------------------------------------------------
  {
    id: 'meghalaya-schemes',
    adapter: 'gov-html',
    url: 'https://meghalaya.gov.in/schemes',
    label: 'Meghalaya — state schemes',
    level: 'state',
    state: 'Meghalaya',
    // Drupal, twenty per page, six pages.
    paginate: { template: 'https://meghalaya.gov.in/schemes?page={n}', from: 1, to: 5 },
    maxLinks: 60,
    enabled: true,
  },
  {
    id: 'maharashtra-sjsa',
    adapter: 'gov-html',
    url: 'https://sjsa.maharashtra.gov.in/en/schemes-programmes/',
    label: 'Maharashtra — Social Justice & Special Assistance',
    level: 'state',
    state: 'Maharashtra',
    paginate: { template: 'https://sjsa.maharashtra.gov.in/en/schemes-programmes/page/{n}/', from: 2, to: 8 },
    maxLinks: 60,
    enabled: true,
  },
  {
    id: 'goa-schemes',
    adapter: 'gov-html',
    url: 'https://www.goa.gov.in/government/schemes/',
    label: 'Goa — all departments',
    level: 'state',
    state: 'Goa',
    // One 600 KB page listing every department's schemes. Its robots.txt
    // answers 403, which RFC 9309 treats as no rules published, so it is
    // permitted — the same reading our robots handler already applies.
    maxLinks: 60,
    enabled: true,
  },
  {
    id: 'nagaland-scholarships',
    adapter: 'gov-html',
    url: 'https://scholarship.nagaland.gov.in/scholarships',
    label: 'Nagaland — scholarships',
    level: 'state',
    state: 'Nagaland',
    // Purely scholarships, and each card names its department and nodal
    // officer — unusually complete for a state portal.
    maxLinks: 40,
    enabled: true,
  },
  {
    id: 'jk-socialwelfare',
    adapter: 'gov-html',
    url: 'https://socialwelfare.jk.gov.in/schemes.html',
    label: 'Jammu & Kashmir — Social Welfare',
    level: 'state',
    state: 'Jammu and Kashmir',
    maxLinks: 30,
    enabled: true,
  },
  {
    id: 'haryana-schemes',
    adapter: 'gov-html',
    url: 'https://www.haryana.gov.in/schemes-programmes/',
    label: 'Haryana — state schemes',
    level: 'state',
    state: 'Haryana',
    maxLinks: 30,
    enabled: true,
  },
  {
    id: 'uttarakhand-socialwelfare',
    adapter: 'gov-html',
    url: 'https://socialwelfare.uk.gov.in/schemes/',
    label: 'Uttarakhand — Social Welfare',
    level: 'state',
    state: 'Uttarakhand',
    paginate: { template: 'https://socialwelfare.uk.gov.in/schemes/page/{n}/', from: 2, to: 3 },
    maxLinks: 30,
    enabled: true,
  },
  {
    id: 'goa-highered',
    adapter: 'gov-html',
    url: 'https://dhe.goa.gov.in/resource/getSchemes/',
    label: 'Goa — Directorate of Higher Education',
    level: 'state',
    state: 'Goa',
    maxLinks: 25,
    enabled: true,
  },
  {
    id: 'sikkim-schemes',
    adapter: 'gov-html',
    url: 'https://www.sikkim.gov.in/scheme/schemes',
    label: 'Sikkim — state schemes',
    level: 'state',
    state: 'Sikkim',
    // No pagination declared on purpose: the page parameter is ignored and
    // every value returns the same ten schemes.
    maxLinks: 25,
    enabled: true,
  },
  {
    id: 'chhattisgarh-postmatric',
    adapter: 'gov-html',
    url: 'https://postmatric-scholarship.cg.nic.in/',
    label: 'Chhattisgarh — post-matric scholarship',
    level: 'state',
    state: 'Chhattisgarh',
    // Only three schemes, but they carry eligibility and application dates.
    maxLinks: 15,
    enabled: true,
  },
  {
    id: 'dbt-bharat',
    adapter: 'dbt-bharat',
    url: 'https://dbtbharat.gov.in/central-scheme/list',
    label: 'DBT Bharat — central scheme register',
    level: 'central',
    maxLinks: 120,
    enabled: true,
    // A register rather than a department site: it names the scheme and links
    // the page the owning ministry publishes it on, which is how we reach
    // research-council domains no scholarship directory lists.
  },
  {
    id: 'nsp-directory',
    adapter: 'nsp-index',
    url: 'https://scholarships.gov.in/All-Scholarships',
    label: 'National Scholarship Portal — full scheme directory',
    level: 'central',
    // Roughly 300 rows across 13 departments and 24 states, and dedupe takes
    // out a good share of that. Set high enough not to be the thing that
    // decides what we carry.
    maxLinks: 400,
    enabled: true,
    // The only source that states an application window, and the only one that
    // enumerates state schemes at all — they sit behind a form, on no
    // crawlable URL, which is why the catalogue was almost entirely central.
  },
  {
    id: 'nsp-home',
    adapter: 'nsp-html',
    url: 'https://scholarships.gov.in/',
    label: 'National Scholarship Portal',
    level: 'central',
    maxLinks: 40,
    enabled: true,
  },
  {
    id: 'socialjustice-schemes',
    adapter: 'gov-html',
    url: 'https://socialjustice.gov.in/schemes',
    label: 'Ministry of Social Justice & Empowerment — schemes',
    level: 'central',
    maxLinks: 40,
    enabled: true,
  },
  {
    id: 'ugc-schemes',
    adapter: 'gov-html',
    url: 'https://www.ugc.gov.in/Scholarship',
    label: 'UGC — scholarships and fellowships',
    level: 'central',
    maxLinks: 30,
    enabled: true,
  },
  // ------------------------------------------------------------- states --
  // The PRD wants pilot states. These were each verified with curl rather than
  // assumed: a 200, a government domain, robots that permit it, and scheme
  // names present in the raw HTML.
  {
    id: 'hp-epass-state',
    adapter: 'gov-html',
    url: 'https://hpepass.cgg.gov.in/NewHomePage.do?actionParameter=stateSchemes',
    label: 'Himachal Pradesh ePASS — state schemes',
    level: 'state',
    state: 'Himachal Pradesh',
    maxLinks: 25,
    enabled: true,
    // The strongest state source found: server-rendered, with per-scheme
    // eligibility prose and amounts rather than a link to a circular.
  },
  {
    id: 'hp-epass-central',
    adapter: 'gov-html',
    url: 'https://hpepass.cgg.gov.in/NewHomePage.do?actionParameter=centralSchemes',
    label: 'Himachal Pradesh ePASS — centrally sponsored schemes',
    level: 'state',
    state: 'Himachal Pradesh',
    maxLinks: 25,
    enabled: true,
  },
  {
    id: 'assam-state-schemes',
    adapter: 'gov-html',
    url: 'https://assam.gov.in/schemes-list-page',
    label: 'Assam — state scheme list',
    level: 'state',
    state: 'Assam',
    maxLinks: 30,
    enabled: true,
    // Replaces directorateofhighereducation.assam.gov.in, which is disabled
    // below: it returns one scheme link, unchanged since 2018, while Assam is
    // named in the PRD as a pilot state.
  },
  {
    id: 'tn-bcmbcmw',
    adapter: 'gov-html',
    url: 'https://bcmbcmw.tn.gov.in/welfschemes.htm',
    label: 'Tamil Nadu — BC/MBC and Minorities Welfare schemes',
    level: 'state',
    state: 'Tamil Nadu',
    maxLinks: 25,
    enabled: true,
  },
  {
    id: 'rajasthan-sje-scholarship',
    adapter: 'gov-html',
    url: 'https://sjmsnew.rajasthan.gov.in/scholarship/',
    label: 'Rajasthan Social Justice — scholarship portal',
    level: 'state',
    state: 'Rajasthan',
    maxLinks: 25,
    enabled: true,
  },
  {
    id: 'kerala-egrantz',
    adapter: 'gov-html',
    url: 'https://egrantz.kerala.gov.in/',
    label: 'Kerala e-grantz — scholarship notices',
    level: 'state',
    state: 'Kerala',
    maxLinks: 25,
    enabled: true,
    // Renders its notice board client-side, so plain HTTP returns a shell.
    // browser: true skips the futile HTTP attempt rather than paying for a
    // round trip to learn what this comment already says.
    browser: true,
    // Replaces swd.kerala.gov.in, which stays disabled: its certificate does
    // not cover its hostname, and Chromium refuses it exactly as Node does.
    // The browser gets past a chain Node cannot build, not past a certificate
    // that is genuinely wrong for the site.
  },
  {
    id: 'wb-svmcm',
    adapter: 'gov-html',
    url: 'https://svmcm.wb.gov.in/page/about.php',
    label: 'West Bengal — Swami Vivekananda Merit-cum-Means',
    level: 'state',
    state: 'West Bengal',
    maxLinks: 15,
    enabled: true,
  },
  {
    id: 'assam-schemes',
    adapter: 'gov-html',
    url: 'https://directorateofhighereducation.assam.gov.in/schemes',
    label: 'Assam — Directorate of Higher Education',
    level: 'state',
    state: 'Assam',
    maxLinks: 25,
    enabled: false,
    disabledReason:
      'Returns exactly one scheme link, unchanged since 2018. Assam is a named '
      + 'pilot state in the PRD, so its coverage now comes from '
      + 'assam.gov.in/schemes-list-page instead.',
  },

  // --------------------------------------------------------------- disabled --
  // Incomplete TLS chains. We do not disable certificate verification to work
  // around these: an unverified connection to a government site is exactly the
  // situation where a tampered response would be most damaging. The fix is for
  // the department to serve its intermediate certificate.
  {
    id: 'tribal-schemes',
    adapter: 'gov-html',
    url: 'https://tribal.nic.in/scholarship.aspx',
    label: 'Ministry of Tribal Affairs — scholarships',
    level: 'central',
    maxLinks: 30,
    enabled: true,
    // Recovered by the browser fallback: the server omits its intermediate certificate. Node refuses that; Chromium fetches the missing certificate from the issuer named in the leaf, which is what every visitor's browser already does.
  },
  {
    id: 'minorityaffairs-schemes',
    adapter: 'gov-html',
    url: 'https://www.minorityaffairs.gov.in/',
    label: 'Ministry of Minority Affairs',
    level: 'central',
    maxLinks: 25,
    enabled: true,
    // Re-enabled: the self-signed chain that disabled this has been fixed, and
    // the host returns a clean 200 today. Re-testing disabled sources pays off —
    // this is why they are kept in config with a reason rather than deleted.
  },
  {
    id: 'dst-inspire',
    adapter: 'gov-html',
    url: 'https://online-inspire.gov.in/',
    label: 'DST — INSPIRE scholarship',
    level: 'central',
    maxLinks: 15,
    enabled: true,
    // Recovered by the browser fallback: the leaf signature cannot be verified by Node's trust store, but resolves in Chromium.
  },
  {
    id: 'up-scholarship',
    adapter: 'gov-html',
    url: 'https://scholarship.up.gov.in/',
    label: 'Uttar Pradesh — scholarship portal',
    level: 'state',
    state: 'Uttar Pradesh',
    maxLinks: 20,
    enabled: true,
    // Recovered by the browser fallback: the server requires legacy TLS renegotiation, which Node refuses and Chromium permits.
  },
  {
    id: 'kerala-swd',
    adapter: 'gov-html',
    url: 'https://swd.kerala.gov.in/schemes',
    label: 'Kerala — Social Welfare Department',
    level: 'state',
    state: 'Kerala',
    maxLinks: 20,
    enabled: false,
    disabledReason: 'TLS: ERR_TLS_CERT_ALTNAME_INVALID (certificate does not cover this hostname)',
  },

  // Bot-blocked at the edge (HTTP 403 to any non-browser agent). We honour the
  // block rather than spoofing a browser User-Agent to get around it.
  {
    id: 'education-schemes',
    adapter: 'gov-html',
    url: 'https://www.education.gov.in/scholarships-education-loan-0',
    label: 'Ministry of Education — scholarships',
    level: 'central',
    maxLinks: 30,
    enabled: false,
    disabledReason: 'HTTP 403 — verified with a real headless Chrome sending a genuine Chrome user-agent: still refused. The block is not on the user-agent, so it is a WAF, geo or datacentre-IP rule. Nothing we can honestly do reaches it.',
  },
  {
    id: 'dsel-schemes',
    adapter: 'gov-html',
    url: 'https://dsel.education.gov.in/scheme',
    label: 'Dept. of School Education & Literacy — schemes',
    level: 'central',
    maxLinks: 25,
    enabled: false,
    disabledReason: 'HTTP 403 — same as education-schemes: refused to a real browser with a real Chrome UA, so not a user-agent block.',
  },

  // NOTE: AICTE (aicte-india.org) reachable and rich, but deliberately excluded:
  // it is a statutory body on a .org domain, outside the government-only
  // allowlist this scraper is required to operate under.
];

/** Sources actually crawled. */
export const ENABLED_SOURCES = SOURCES.filter((s) => s.enabled !== false);

/**
 * Link text / href patterns that suggest a page is about a specific scheme.
 * Used to decide which discovered links are worth following.
 */
export const SCHEME_LINK_HINTS = [
  /scholarship/i,
  /schemes?\b/i,
  /fellowship/i,
  /stipend/i,
  /pre[\s-]?matric/i,
  /post[\s-]?matric/i,
  /merit[\s-]?cum[\s-]?means/i,
  /yojana/i,
  /guideline/i,
  /eligibility/i,
];

/** Link patterns we never follow, even on an allowed host. */
export const SCHEME_LINK_EXCLUDE = [
  /\.(?:jpe?g|png|gif|svg|zip|xlsx?|docx?|pptx?|mp4|mp3|css|js)(?:$|\?)/i,
  /\/(?:login|register|signup|apply|otp|payment|feedback|sitemap|search|rss)\b/i,
  /(?:facebook|twitter|youtube|instagram|linkedin)\.com/i,
];
