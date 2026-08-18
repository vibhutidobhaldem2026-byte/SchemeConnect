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
    id: 'dbt-central-schemes',
    adapter: 'gov-html',
    url: 'https://dbtbharat.gov.in/central-scheme/list',
    label: 'DBT Bharat — central scheme list',
    level: 'central',
    maxLinks: 60,
    enabled: true,
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
  {
    id: 'assam-schemes',
    adapter: 'gov-html',
    url: 'https://directorateofhighereducation.assam.gov.in/schemes',
    label: 'Assam — Directorate of Higher Education',
    level: 'state',
    state: 'Assam',
    maxLinks: 25,
    enabled: true,
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
    enabled: false,
    disabledReason: 'TLS: UNABLE_TO_GET_ISSUER_CERT_LOCALLY (server omits its intermediate certificate)',
  },
  {
    id: 'minorityaffairs-schemes',
    adapter: 'gov-html',
    url: 'https://www.minorityaffairs.gov.in/',
    label: 'Ministry of Minority Affairs',
    level: 'central',
    maxLinks: 25,
    enabled: false,
    disabledReason: 'TLS: SELF_SIGNED_CERT_IN_CHAIN',
  },
  {
    id: 'dst-inspire',
    adapter: 'gov-html',
    url: 'https://online-inspire.gov.in/',
    label: 'DST — INSPIRE scholarship',
    level: 'central',
    maxLinks: 15,
    enabled: false,
    disabledReason: 'TLS: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  },
  {
    id: 'up-scholarship',
    adapter: 'gov-html',
    url: 'https://scholarship.up.gov.in/',
    label: 'Uttar Pradesh — scholarship portal',
    level: 'state',
    state: 'Uttar Pradesh',
    maxLinks: 20,
    enabled: false,
    disabledReason: 'TLS: ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED',
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
    disabledReason: 'HTTP 403 — edge blocks non-browser agents; we do not spoof a browser UA',
  },
  {
    id: 'dsel-schemes',
    adapter: 'gov-html',
    url: 'https://dsel.education.gov.in/scheme',
    label: 'Dept. of School Education & Literacy — schemes',
    level: 'central',
    maxLinks: 25,
    enabled: false,
    disabledReason: 'HTTP 403 — edge blocks non-browser agents',
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
