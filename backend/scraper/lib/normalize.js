/**
 * Canonical Scheme record: the single shape the website consumes.
 *
 * Every field that came from a page carries provenance — which URL, which
 * adapter, when it was fetched, and (where we parsed a criterion out of prose)
 * the sentence it came from. The site never shows a criterion without being
 * able to point at its source.
 */

import { createHash } from 'node:crypto';

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function contentHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** Trims boilerplate and squeezes whitespace out of a scheme title. */
export function cleanName(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:home|schemes?)\s*[»>|/-]\s*/i, '')
    .replace(/\s*[|–—-]\s*(?:national scholarship portal|nsp|ministry of.*|government of india)\s*$/i, '')
    .replace(/\s*\(\s*\)\s*/g, ' ')
    .trim();
}

/**
 * Builds a canonical scheme record.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.sourceUrl        page or PDF the record came from
 * @param {string} input.adapter          which adapter produced it
 * @param {string} input.docType          'html' | 'pdf'
 * @param {string} input.rawText          full extracted text (kept for evidence)
 * @param {object} input.extracted        output of extract.extractAll()
 * @param {string} [input.summary]
 * @param {string} [input.applyUrl]
 * @param {string} [input.level]          'central' | 'state'
 * @param {string} [input.state]
 * @param {string} input.fetchedAt
 */
export function toScheme(input) {
  const name = cleanName(input.name);
  const ex = input.extracted || {};
  const eligibility = ex.eligibility || {};

  const level = input.level
    || (eligibility.states?.length === 1 ? 'state' : 'central');
  const state = input.state || (level === 'state' ? eligibility.states?.[0] ?? null : null);

  const slug = slugify(name) || contentHash(input.sourceUrl);

  return {
    id: `${slug}-${contentHash(input.sourceUrl).slice(0, 6)}`,
    slug,
    name,
    summary: (input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    ministry: input.ministry || ex.ministry || null,
    level,
    state,

    benefit: ex.benefit || null,
    benefitText: formatBenefit(ex.benefit),

    eligibility: {
      maxFamilyIncome: eligibility.maxFamilyIncome ?? null,
      categories: dedupe(eligibility.categories),
      gender: dedupe(eligibility.gender),
      disabilityRequired: Boolean(eligibility.disabilityRequired),
      courseLevels: dedupe(eligibility.courseLevels),
      minMarksPercent: eligibility.minMarksPercent ?? null,
      states: dedupe(eligibility.states),
    },

    criteriaEvidence: (ex.evidence || []).map((e) => ({
      field: e.field,
      text: e.text.slice(0, 400),
    })),

    documents: dedupe(ex.documents),
    deadline: ex.deadline || null,
    applyUrl: input.applyUrl || input.sourceUrl,

    source: {
      url: input.sourceUrl,
      domain: safeHost(input.sourceUrl),
      adapter: input.adapter,
      docType: input.docType,
      fetchedAt: input.fetchedAt,
      contentHash: contentHash(input.rawText || ''),
      textLength: (input.rawText || '').length,
    },

    lastVerified: input.fetchedAt,
    confidence: ex.confidence ?? 0,

    /**
     * 'full'    — we read eligibility criteria out of the source and the
     *             scheme can take part in matching.
     * 'listing' — we have an authoritative name and official URL from a
     *             government listing, but no criteria. Browsable and
     *             searchable, never matched against a student profile.
     */
    detailLevel: 'full',
    warnings: [],
  };
}

/**
 * A scheme we found on an official government listing (a table of
 * "Scheme Name | Website URL") but whose criteria we could not read.
 *
 * These are kept because a verified name plus an official link is genuinely
 * useful to a student, but they are marked so the matcher never treats the
 * absence of criteria as "you qualify".
 */
export function toListingScheme(input) {
  const name = cleanName(input.name);
  const slug = slugify(name) || contentHash(input.officialUrl || input.sourceUrl);

  return {
    id: `${slug}-${contentHash(input.sourceUrl).slice(0, 6)}`,
    slug,
    name,
    summary: (input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    ministry: input.ministry || null,
    level: input.level || 'central',
    state: input.state || null,

    benefit: null,
    benefitText: null,

    eligibility: {
      maxFamilyIncome: null,
      categories: [],
      gender: [],
      disabilityRequired: false,
      courseLevels: [],
      minMarksPercent: null,
      states: input.state ? [input.state] : [],
    },

    criteriaEvidence: [],
    documents: [],
    deadline: null,
    applyUrl: input.officialUrl || input.sourceUrl,

    source: {
      url: input.sourceUrl,
      domain: safeHost(input.sourceUrl),
      adapter: input.adapter,
      docType: 'html-listing',
      fetchedAt: input.fetchedAt,
      contentHash: contentHash(name + (input.officialUrl || '')),
      textLength: 0,
      listedOn: input.sourceUrl,
      officialUrl: input.officialUrl || null,
    },

    lastVerified: input.fetchedAt,
    confidence: 0,
    detailLevel: 'listing',
    warnings: ['Eligibility criteria not yet extracted — check the official page.'],
  };
}

function dedupe(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function formatBenefit(benefit) {
  if (!benefit) return null;
  const fmt = (n) => '₹' + n.toLocaleString('en-IN');
  const period = benefit.period === 'month' ? '/month' : benefit.period === 'year' ? '/year' : '';
  if (benefit.min === benefit.max) return `${fmt(benefit.max)}${period}`;
  return `${fmt(benefit.min)} – ${fmt(benefit.max)}${period}`;
}

/**
 * Quality gate. A record that fails validation is dropped rather than shipped,
 * because a half-parsed scheme shown to a student is worse than no scheme —
 * this is the same reasoning as the PRD's "show nothing rather than a
 * misleading list" rule for uncovered states.
 */
/** Titles that are navigation furniture rather than a scheme. */
const NAV_PAGE_NAMES =
  /^(home|schemes?|dbt schemes?|all schemes?|list of schemes?|scheme list|schemes on nsp|search|sitemap|contact us|about us|notifications?|downloads?|faqs?|login|guidelines?|circulars?)$/i;

/** A name has to at least mention a scheme-ish noun to be a scheme. */
const SCHEME_NAME_RE = /scholarship|scheme|yojana|fellowship|stipend|award|grant|vriti|chhatra|puraskar/i;

/**
 * Signals that a scheme is about education.
 *
 * SchemeConnect is a catalogue of scholarships for school and college students.
 * Without this gate the crawl pulled in every central DBT scheme it could see —
 * the Coal Mines Pension Scheme, Employees' Pension for EPF members, the Coir
 * Vikas Yojana, FAME India vehicle subsidies, Atal Pension Yojana — because
 * each of them contains the word "Scheme" or "Yojana". A student browsing for a
 * scholarship was being shown pension and textile schemes, and one welfare
 * scheme for senior citizens was even being offered as a match.
 */
const EDUCATION_SIGNAL = new RegExp([
  'scholarship', 'fellowship', 'stipend', 'schol[ae]r',
  'student', 'pupil', 'learner',
  'educat', 'school', 'college', 'university', 'institute of technology',
  'academic', 'tuition', 'hostel', 'matric', 'graduat', 'doctoral',
  'vidya', 'shiksha', 'chhatra', 'vriti', 'siksha', 'padho',
  'coaching', 'apprentice', 'skill', 'training', 'research',
].join('|'), 'i');

/**
 * Whether this looks like something a student could apply for.
 *
 * Checked against the name, summary and ministry, plus the sentences the
 * extractor quoted from the page. A scheme's title can be entirely opaque —
 * PM-DAKSH names no subject at all in English — while the criteria it quotes
 * talk about training programmes, trainees and stipends. For a listing-only
 * entry the name is usually all there is.
 */
export function looksEducational(scheme) {
  const haystack = [
    scheme.name,
    scheme.summary,
    scheme.ministry,
    ...(scheme.criteriaEvidence ?? []).map((e) => e.text),
    ...(scheme.documents ?? []),
  ].filter(Boolean).join(' ');
  return EDUCATION_SIGNAL.test(haystack);
}

/**
 * Page furniture and notice-board items that read like scheme names.
 *
 * A government scholarship page carries navigation ("Apply For Scholarship",
 * "Scholarship Eligibility", "Nodal Officers") and a rolling notice board
 * ("List of provisionally selected candidates", "Ministry invites online
 * applications for..."). Both satisfy every other test — the words are right,
 * the domain is right, the page is real — so they entered the catalogue as
 * schemes. Every one of them was later found to have a dead or meaningless
 * link, which is the symptom rather than the problem: an announcement about a
 * scheme is not a scheme, and a student clicking it has been sent to a notice.
 */
const NOT_A_SCHEME = new RegExp([
  // Notices and result lists
  '^(amended\\s+)?list of\\b',
  '\\bprovisionally selected\\b',
  '\\bselected candidates?\\b',
  '^ministry invites\\b',
  '\\bonline applications? (are )?invited\\b',
  '^online application invited\\b',
  '\\bapplicants processed\\b',
  '\\bmerit list\\b',
  '\\bcorrigendum\\b',
  '\\bnotice\\b.*\\bdated\\b',
  // Navigation and portal chrome
  '^(apply|login|register|sign in)\\b',
  '^scholarship (portal|eligibility|dashboard|status)$',
  '^(nodal|state nodal|district nodal) officers?\\b',
  '\\bhelp\\s?desk\\b',
  '^(faq|faqs|user manual|guidelines?)$',
  '^(click here|read more|view all|know more)$',
].join('|'), 'i');

export function validateScheme(scheme) {
  const problems = [];
  const isListing = scheme.detailLevel === 'listing';

  if (!scheme.name || scheme.name.length < 8) problems.push('name missing or too short');
  if (scheme.name && scheme.name.length > 200) problems.push('name implausibly long');
  if (!scheme.source?.url) problems.push('no source URL');
  if (scheme.name && NAV_PAGE_NAMES.test(scheme.name.trim())) {
    problems.push('looks like a navigation page, not a scheme');
  }

  const e = scheme.eligibility || {};
  if (e.maxFamilyIncome !== null && (e.maxFamilyIncome < 10000 || e.maxFamilyIncome > 10000000)) {
    problems.push(`income ceiling out of plausible range (${e.maxFamilyIncome})`);
  }
  if (scheme.deadline && Number.isNaN(Date.parse(scheme.deadline))) {
    problems.push('unparseable deadline');
  }

  // Applies to both tiers: a page title like "Welcome to UGC, New Delhi" is a
  // homepage, not a scheme, however much criteria-like text the page contains.
  if (!SCHEME_NAME_RE.test(scheme.name || '')) {
    problems.push('name does not look like a scheme');
  }
  if (/^(welcome to|home\s*[|–-]|department of|ministry of|directorate of|government of)\b/i.test((scheme.name || '').trim())) {
    problems.push('name is an organisation or landing page, not a scheme');
  }
  // Table header rows get flattened into a single line and can look like a name:
  // "Sl. Scheme Scheme State Officer Designation Level Telephone Email".
  // The catalogue is for students. A scheme with no educational signal anywhere
  // in its name, summary or ministry is something else — and showing it to a
  // student is worse than showing nothing.
  if (!looksEducational(scheme)) {
    problems.push('not a student scheme — no educational signal in name or summary');
  }
  if (NOT_A_SCHEME.test(String(scheme.name ?? '').trim())) {
    problems.push('a notice or a navigation link, not a scheme');
  }
  if (/^sl\.?\s|\bdesignation\b|\btelephone\b|\be-?mail\b|\bcontact\s*no\b/i.test(scheme.name || '')) {
    problems.push('name looks like a flattened table header row');
  }

  if (isListing) {
    // A listing record only has to be a plausible scheme name from an official
    // government listing. It carries no criteria and never enters matching, so
    // the criteria checks below do not apply.
    return { valid: problems.length === 0, problems };
  }

  if ((scheme.source?.textLength ?? 0) < 400) problems.push('source text too short to trust');

  const hasAnyCriterion =
    e.maxFamilyIncome !== null ||
    e.categories.length > 0 ||
    e.courseLevels.length > 0 ||
    e.gender.length > 0 ||
    e.disabilityRequired ||
    e.minMarksPercent !== null;
  if (!hasAnyCriterion) problems.push('no eligibility criterion could be extracted');

  return { valid: problems.length === 0, problems };
}

/**
 * Merges duplicates that describe the same scheme from different URLs,
 * keeping the record with the most extracted signal.
 */
export function dedupeSchemes(schemes) {
  const byKey = new Map();
  for (const scheme of schemes) {
    const key = scheme.slug;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, scheme);
      continue;
    }
    // A record with real criteria always beats a listing-only one.
    const score = (s) =>
      (s.detailLevel === 'full' ? 100 : 0) +
      s.confidence * 10 +
      (s.source.textLength || 0) / 10000 +
      s.criteriaEvidence.length;
    const winner = score(scheme) >= score(existing) ? scheme : existing;
    const loser = winner === scheme ? existing : scheme;

    // Keep the alternate source visible rather than discarding it silently.
    winner.alternateSources = [
      ...(winner.alternateSources || []),
      { url: loser.source.url, adapter: loser.source.adapter },
    ];
    byKey.set(key, winner);
  }
  return [...byKey.values()];
}
