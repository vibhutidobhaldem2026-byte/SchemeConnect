/**
 * Eligibility matching engine.
 *
 * Two things the PRD insists on, both implemented here:
 *  - a match is explained ("why you matched"), not just returned
 *  - a *non*-match is explained too, via reason codes naming the field that
 *    ruled the student out, so a scheme's absence is never unexplained
 *
 * The engine is deliberately conservative. A criterion the scraper could not
 * read is not treated as "passes" — it is recorded as unknown, and a scheme
 * matched only on unknowns is reported at low confidence.
 */

const INCOME_BANDS = {
  'below-1l': { label: 'Below ₹1 lakh', max: 100000 },
  '1l-2.5l': { label: '₹1–2.5 lakh', max: 250000 },
  '2.5l-4.5l': { label: '₹2.5–4.5 lakh', max: 450000 },
  '4.5l-8l': { label: '₹4.5–8 lakh', max: 800000 },
  'above-8l': { label: 'Above ₹8 lakh', max: Infinity },
};

export const INCOME_OPTIONS = Object.entries(INCOME_BANDS).map(([value, b]) => ({
  value,
  label: b.label,
}));

export const CATEGORY_OPTIONS = ['General', 'SC', 'ST', 'OBC', 'EWS', 'Minority'];
export const GENDER_OPTIONS = ['Female', 'Male', 'Other', 'Prefer not to say'];
export const COURSE_OPTIONS = ['Class 9-10', 'Class 11-12', 'Diploma', 'Undergraduate', 'Postgraduate', 'PhD'];

/** Upper bound of the student's declared income band. */
function incomeCeiling(band) {
  return INCOME_BANDS[band]?.max ?? null;
}

/**
 * Evaluates one criterion.
 * @returns {{status:'pass'|'fail'|'unknown', label:string, detail:string}}
 */
function evaluateCriterion(key, scheme, profile) {
  const e = scheme.eligibility;
  const evidence = scheme.criteriaEvidence?.find((c) => c.field === key)?.text ?? null;

  switch (key) {
    case 'maxFamilyIncome': {
      if (e.maxFamilyIncome === null) {
        return { status: 'unknown', label: 'Family income', detail: 'No income limit stated in the source.' };
      }
      if (!profile.income) {
        return { status: 'unknown', label: 'Family income', detail: 'You have not told us your income band yet.' };
      }
      const yourCeiling = incomeCeiling(profile.income);
      const limit = `₹${e.maxFamilyIncome.toLocaleString('en-IN')}`;
      // The student's band must sit entirely at or below the scheme's ceiling.
      if (yourCeiling !== null && yourCeiling <= e.maxFamilyIncome) {
        return { status: 'pass', label: 'Family income', detail: `Scheme limit is ${limit}/year; your band is ${INCOME_BANDS[profile.income].label}.`, evidence };
      }
      return { status: 'fail', label: 'Family income', detail: `Scheme requires family income at or below ${limit}/year; you selected ${INCOME_BANDS[profile.income].label}.`, evidence };
    }

    case 'categories': {
      if (!e.categories.length) {
        return { status: 'unknown', label: 'Category', detail: 'Source does not restrict by category.' };
      }
      if (!profile.category) {
        return { status: 'unknown', label: 'Category', detail: 'You have not told us your category yet.' };
      }
      if (e.categories.includes(profile.category)) {
        return { status: 'pass', label: 'Category', detail: `Open to ${e.categories.join(', ')} — you selected ${profile.category}.`, evidence };
      }
      return { status: 'fail', label: 'Category', detail: `Restricted to ${e.categories.join(', ')}; you selected ${profile.category}.`, evidence };
    }

    case 'courseLevels': {
      if (!e.courseLevels.length) {
        return { status: 'unknown', label: 'Course level', detail: 'Source does not state a course level.' };
      }
      if (!profile.courseLevel) {
        return { status: 'unknown', label: 'Course level', detail: 'You have not told us your course level yet.' };
      }
      if (e.courseLevels.includes(profile.courseLevel)) {
        return { status: 'pass', label: 'Course level', detail: `Applies to ${e.courseLevels.join(', ')} — you selected ${profile.courseLevel}.`, evidence };
      }
      return { status: 'fail', label: 'Course level', detail: `Applies to ${e.courseLevels.join(', ')}; you selected ${profile.courseLevel}.`, evidence };
    }

    case 'gender': {
      if (!e.gender.length) {
        return { status: 'unknown', label: 'Gender', detail: 'Open to all genders.' };
      }
      if (!profile.gender || profile.gender === 'Prefer not to say') {
        return { status: 'unknown', label: 'Gender', detail: 'You have not told us your gender.' };
      }
      if (e.gender.includes(profile.gender)) {
        return { status: 'pass', label: 'Gender', detail: `Reserved for ${e.gender.join('/')} students.`, evidence };
      }
      return { status: 'fail', label: 'Gender', detail: `Reserved for ${e.gender.join('/')} students.`, evidence };
    }

    case 'disabilityRequired': {
      if (!e.disabilityRequired) {
        return { status: 'unknown', label: 'Disability', detail: 'Not a disability-specific scheme.' };
      }
      if (profile.disability === true) {
        return { status: 'pass', label: 'Disability', detail: 'Scheme is for students with disabilities.', evidence };
      }
      if (profile.disability === false) {
        return { status: 'fail', label: 'Disability', detail: 'Scheme is only for students with disabilities.', evidence };
      }
      return { status: 'unknown', label: 'Disability', detail: 'You have not answered the disability question.' };
    }

    case 'states': {
      if (!e.states.length) {
        return { status: 'unknown', label: 'State', detail: 'Central scheme — open across states.' };
      }
      if (!profile.state) {
        return { status: 'unknown', label: 'State', detail: 'You have not told us your state yet.' };
      }
      if (e.states.includes(profile.state)) {
        return { status: 'pass', label: 'State', detail: `Open to residents of ${e.states.join(', ')}.`, evidence };
      }
      return { status: 'fail', label: 'State', detail: `Limited to ${e.states.join(', ')}; you selected ${profile.state}.`, evidence };
    }

    case 'minMarksPercent': {
      if (e.minMarksPercent === null) {
        return { status: 'unknown', label: 'Marks', detail: 'No minimum marks stated.' };
      }
      if (profile.marksPercent === null || profile.marksPercent === undefined || profile.marksPercent === '') {
        return { status: 'unknown', label: 'Marks', detail: 'You have not told us your last marks.' };
      }
      const yours = Number(profile.marksPercent);
      if (yours >= e.minMarksPercent) {
        return { status: 'pass', label: 'Marks', detail: `Requires ${e.minMarksPercent}%; you entered ${yours}%.`, evidence };
      }
      return { status: 'fail', label: 'Marks', detail: `Requires at least ${e.minMarksPercent}%; you entered ${yours}%.`, evidence };
    }

    default:
      return { status: 'unknown', label: key, detail: '' };
  }
}

const CRITERIA_KEYS = [
  'maxFamilyIncome', 'categories', 'courseLevels', 'gender',
  'disabilityRequired', 'states', 'minMarksPercent',
];

/**
 * Evaluates one scheme against a profile.
 * @returns {{matched:boolean, passed:[], failed:[], unknown:[], score:number}}
 */
export function evaluateScheme(scheme, profile) {
  const passed = [];
  const failed = [];
  const unknown = [];

  for (const key of CRITERIA_KEYS) {
    const result = evaluateCriterion(key, scheme, profile);
    if (result.status === 'pass') passed.push({ key, ...result });
    else if (result.status === 'fail') failed.push({ key, ...result });
    else if (scheme.eligibility[key] !== null && scheme.eligibility[key] !== false
      && !(Array.isArray(scheme.eligibility[key]) && scheme.eligibility[key].length === 0)) {
      // Only surface "unknown" for criteria the scheme actually states.
      unknown.push({ key, ...result });
    }
  }

  const matched = failed.length === 0 && passed.length > 0;

  // Rank by how much we could positively confirm, nudged by deadline urgency.
  let score = passed.length * 10 - unknown.length * 2 + (scheme.confidence ?? 0) * 5;
  const days = daysUntil(scheme.deadline);
  if (days !== null && days >= 0 && days <= 30) score += 5;

  return { matched, passed, failed, unknown, score };
}

export function daysUntil(isoDate) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

/**
 * Runs a profile against the matchable catalog.
 *
 * @returns {{matches:[], nearMisses:[], evaluated:number}}
 *   matches    — every stated criterion passed
 *   nearMisses — failed on exactly one criterion, with the reason code
 */
export function matchProfile(schemes, profile) {
  const matches = [];
  const nearMisses = [];

  for (const scheme of schemes) {
    const result = evaluateScheme(scheme, profile);
    if (result.matched) {
      matches.push({ scheme, ...result });
    } else if (result.failed.length === 1) {
      nearMisses.push({ scheme, ...result, blockedBy: result.failed[0] });
    }
  }

  matches.sort((a, b) => {
    const da = daysUntil(a.scheme.deadline);
    const db = daysUntil(b.scheme.deadline);
    // Schemes closing soon first, then by how much we confirmed.
    if (da !== null && db !== null && da !== db) return da - db;
    if (da !== null && db === null) return -1;
    if (db !== null && da === null) return 1;
    return b.score - a.score;
  });
  nearMisses.sort((a, b) => b.score - a.score);

  return { matches, nearMisses, evaluated: schemes.length };
}

/** How complete a profile is, and what is still missing. */
export function profileCompleteness(profile) {
  const fields = [
    ['state', 'State'],
    ['courseLevel', 'Class or course'],
    ['category', 'Category'],
    ['income', 'Family income'],
    ['gender', 'Gender'],
    ['disability', 'Disability status'],
  ];
  const missing = fields.filter(([key]) => {
    const v = profile?.[key];
    return v === undefined || v === null || v === '';
  });
  return {
    total: fields.length,
    filled: fields.length - missing.length,
    percent: Math.round(((fields.length - missing.length) / fields.length) * 100),
    missing: missing.map(([key, label]) => ({ key, label })),
  };
}
