/**
 * Heuristic extraction of structured eligibility criteria from the prose of a
 * government scheme page or circular.
 *
 * Every extractor returns both the value and the sentence it came from, so the
 * site can show a student the source wording rather than only our reading of
 * it — and so a reviewer can spot a bad parse in the ops dashboard. Nothing
 * here is presented to a user as authoritative; the scheme's own guideline is.
 */

export const CATEGORY_CODES = ['SC', 'ST', 'OBC', 'EWS', 'Minority', 'General'];

export const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
];

export const COURSE_LEVELS = [
  'Class 9-10', 'Class 11-12', 'Diploma', 'Undergraduate', 'Postgraduate', 'PhD',
];

/**
 * Splits text into sentences/bullets for per-claim attribution.
 *
 * Government scheme text is dense with abbreviations — "Rs. 2,50,000",
 * "No. 12", "Sr. No." — so a naive split on ". " severs an amount from the
 * criterion that introduced it and the value is silently lost. We only break
 * where the following token actually starts a new sentence (a capital letter,
 * a bullet or an opening bracket), which leaves "Rs. 2,50,000" intact.
 */
export function sentences(text) {
  return String(text)
    .split(/(?<=[.;:])\s+(?=[A-Z(•\[])|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3 && s.length < 600);
}

/**
 * Parses an Indian rupee amount, including lakh/crore word forms.
 * "Rs. 2,50,000" -> 250000 ; "₹2.5 lakh" -> 250000 ; "1 crore" -> 10000000
 */
export function parseIndianAmount(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase().replace(/,/g, '');
  const m = /(?:rs\.?|inr|₹)?\s*([0-9]+(?:\.[0-9]+)?)\s*(lakhs?|lacs?|crores?|thousand)?/i.exec(text);
  if (!m) return null;
  let value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit.startsWith('lakh') || unit.startsWith('lac')) value *= 100000;
  else if (unit.startsWith('crore')) value *= 10000000;
  else if (unit.startsWith('thousand')) value *= 1000;
  return Math.round(value);
}

/** Annual family-income ceiling, if the text states one. */
export function extractIncomeCeiling(text) {
  const patterns = [
    /(?:annual|yearly|family|parental|parents?[''`]?)\s*(?:family\s*)?income[^.;\n]{0,80}?(?:not\s*(?:exceed|be\s*more\s*than)|less\s*than|below|up\s*to|upto|maximum\s*of|ceiling\s*of|limit\s*of)[^.;\n]{0,20}?((?:rs\.?|inr|₹)?\s*[0-9][0-9,.]*\s*(?:lakhs?|lacs?|crores?|thousand)?)/i,
    /income[^.;\n]{0,40}?(?:should|shall|must)\s*not\s*exceed[^.;\n]{0,20}?((?:rs\.?|inr|₹)?\s*[0-9][0-9,.]*\s*(?:lakhs?|lacs?|crores?|thousand)?)/i,
    /((?:rs\.?|inr|₹)\s*[0-9][0-9,.]*\s*(?:lakhs?|lacs?|crores?)?)\s*(?:or\s*less\s*)?per\s*annum[^.;\n]{0,30}income/i,
  ];
  for (const re of patterns) {
    for (const s of sentences(text)) {
      const m = re.exec(s);
      if (!m) continue;
      const amount = parseIndianAmount(m[1]);
      // Sanity band: a family-income ceiling below ₹10k or above ₹1cr is a misparse.
      if (amount && amount >= 10000 && amount <= 10000000) {
        return { maxFamilyIncome: amount, evidence: s };
      }
    }
  }
  return null;
}

/** Social categories the scheme is restricted to. */
export function extractCategories(text) {
  const found = new Set();
  let evidence = '';
  const patterns = [
    [/\bscheduled\s+caste(?:s)?\b|\bsc\s*(?:\/|,|and|&)\s*st\b|\bsc\s+students?\b|\bsc\s+candidates?\b/i, 'SC'],
    [/\bscheduled\s+tribe(?:s)?\b|\bst\s+students?\b|\bst\s+candidates?\b|\bsc\s*(?:\/|,|and|&)\s*st\b/i, 'ST'],
    [/\bother\s+backward\s+class(?:es)?\b|\bobc\b/i, 'OBC'],
    [/\beconomically\s+weaker\s+section(?:s)?\b|\bews\b/i, 'EWS'],
    [/\bminorit(?:y|ies)\b|\bmuslim\b.*\bchristian\b|\bnotified\s+minorit/i, 'Minority'],
  ];
  for (const s of sentences(text)) {
    if (!/eligib|applicant|candidate|student|belong|categor|reserved/i.test(s)) continue;
    for (const [re, code] of patterns) {
      if (re.test(s)) {
        found.add(code);
        if (!evidence) evidence = s;
      }
    }
  }
  return found.size ? { categories: [...found], evidence } : null;
}

/**
 * Gender restriction — only where the scheme is genuinely limited to one gender.
 *
 * The hard case is a reservation quota: "30% of the scholarships are earmarked
 * for female candidates" describes a sub-quota within an open scheme, not a
 * restriction. Reading that as "women only" would wrongly exclude every male
 * applicant from a scheme they qualify for, so quota language is rejected
 * outright and an explicit exclusivity marker is required.
 */
const QUOTA_LANGUAGE =
  /\d\s*%|\bper\s?cent\b|\bpercent\b|earmark|reserv(ed|ation)\s+(for|of)|\bquota\b|\bpreference\b|\bhorizontal\b|\bsub-?quota\b|\bout\s+of\s+(the\s+)?total\b/i;

const EXCLUSIVITY =
  /\bonly\b|\bexclusively\b|\bsolely\b|\bmeant\s+(only\s+)?for\b|\brestricted\s+to\b|\bconfined\s+to\b|\bopen\s+only\s+to\b|\bshall\s+be\s+(a\s+)?(girl|female|women|woman)\b/i;

const MIXED_GENDER = /\bboth\b|\bboys?\s+and\s+girls?\b|\bgirls?\s+and\s+boys?\b|\bmale\s+and\s+female\b|\bfemale\s+and\s+male\b|\ball\s+genders?\b/i;

export function extractGender(text) {
  for (const s of sentences(text)) {
    if (QUOTA_LANGUAGE.test(s)) continue; // a quota is not a restriction
    if (MIXED_GENDER.test(s)) continue;
    if (!EXCLUSIVITY.test(s)) continue;

    if (/\b(girl|female|women|woman)\s*(students?|candidates?|applicants?|child|children)?\b/i.test(s)) {
      return { gender: ['Female'], evidence: s };
    }
    if (/\b(boy|male|men)\s*(students?|candidates?|applicants?)?\b/i.test(s)) {
      return { gender: ['Male'], evidence: s };
    }
  }
  return null;
}

/** Whether the scheme is specifically for students with disabilities. */
export function extractDisability(text) {
  for (const s of sentences(text)) {
    if (/\b(persons?\s+with\s+disabilit|divyang|differently[\s-]abled|pwd\s+students?|visually\s+impaired|hearing\s+impaired)\b/i.test(s)) {
      if (/\bonly\b|\bexclusively\b|\bmeant\s+for\b|\bfor\s+students?\s+with\b/i.test(s)) {
        return { disabilityRequired: true, evidence: s };
      }
    }
  }
  return null;
}

/** Course / class levels the scheme applies to. */
export function extractCourseLevels(text) {
  const found = new Set();
  let evidence = '';
  const rules = [
    [/\bpre[\s-]?matric\b|\bclass(?:es)?\s*(?:i?x|9)\s*(?:to|-|–|and)\s*(?:x|10)\b|\bclass\s*(?:ix|x|9|10)\b/i, 'Class 9-10'],
    [/\bpost[\s-]?matric\b|\bclass(?:es)?\s*(?:xi|11)\s*(?:to|-|–|and)\s*(?:xii|12)\b|\bclass\s*(?:xi|xii|11|12)\b|\bhigher\s+secondary\b|\bsenior\s+secondary\b|\bintermediate\b/i, 'Class 11-12'],
    [/\bdiploma\b|\bpolytechnic\b|\biti\b/i, 'Diploma'],
    [/\bunder[\s-]?graduate\b|\bug\b|\bbachelor\b|\bb\.?\s?(?:a|sc|com|tech|e)\b|\bgraduation\b/i, 'Undergraduate'],
    [/\bpost[\s-]?graduate\b|\bpg\b|\bmaster\b|\bm\.?\s?(?:a|sc|com|tech|e)\b/i, 'Postgraduate'],
    [/\bph\.?\s?d\b|\bdoctoral\b|\bresearch\s+scholar\b|\bm\.?\s?phil\b/i, 'PhD'],
  ];
  for (const s of sentences(text)) {
    if (!/eligib|studying|pursuing|enrolled|admitted|course|class|student/i.test(s)) continue;
    for (const [re, level] of rules) {
      if (re.test(s)) {
        found.add(level);
        if (!evidence) evidence = s;
      }
    }
  }
  return found.size ? { courseLevels: [...found], evidence } : null;
}

/** Minimum marks / percentage requirement. */
export function extractMinMarks(text) {
  for (const s of sentences(text)) {
    const m = /(?:secured|obtained|scored|minimum\s+of|at\s+least|not\s+less\s+than)[^.;\n]{0,40}?([0-9]{2}(?:\.[0-9]+)?)\s*(?:%|per\s*cent|percent)/i.exec(s);
    if (m) {
      const pct = parseFloat(m[1]);
      if (pct >= 30 && pct <= 95) return { minMarksPercent: pct, evidence: s };
    }
  }
  return null;
}

/** States the scheme is limited to (for state-level schemes). */
export function extractStates(text) {
  const found = new Set();
  let evidence = '';
  for (const s of sentences(text)) {
    if (!/\b(domicile|resident|belonging\s+to|state\s+of|native\s+of|permanent\s+resident)\b/i.test(s)) continue;
    for (const state of STATES) {
      if (new RegExp(`\\b${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s)) {
        found.add(state);
        if (!evidence) evidence = s;
      }
    }
  }
  return found.size ? { states: [...found], evidence } : null;
}

/** Benefit amount, as a range where the text gives one. */
export function extractBenefit(text) {
  const candidates = [];
  for (const s of sentences(text)) {
    if (!/scholarship|stipend|assistance|amount|benefit|award|grant|rs\.?|₹/i.test(s)) continue;
    const re = /((?:rs\.?|inr|₹)\s*[0-9][0-9,.]*\s*(?:lakhs?|lacs?|crores?|thousand)?)/gi;
    let m;
    while ((m = re.exec(s))) {
      const amount = parseIndianAmount(m[1]);
      if (!amount || amount < 500 || amount > 5000000) continue;
      const period = /per\s*(annum|year|month|mensem)|monthly|annually|p\.?a\.?/i.exec(s);
      candidates.push({
        amount,
        period: period ? (/month|mensem|monthly/i.test(period[0]) ? 'month' : 'year') : null,
        evidence: s,
      });
    }
  }
  if (!candidates.length) return null;
  const amounts = candidates.map((c) => c.amount);
  return {
    benefitMin: Math.min(...amounts),
    benefitMax: Math.max(...amounts),
    benefitPeriod: candidates.find((c) => c.period)?.period || null,
    evidence: candidates[0].evidence,
  };
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Application deadline, if stated. Returns ISO date string. */
export function extractDeadline(text) {
  for (const s of sentences(text)) {
    if (!/last\s*date|closing\s*date|deadline|on\s+or\s+before|appl(?:y|ication|ications)[^.]{0,60}(?:by|before|until|till)|submi(?:t|tted|ssion)[^.]{0,60}(?:by|before)|window\s*closes|valid\s*(?:up\s*to|till|until)/i.test(s)) continue;

    let m = /\b([0-3]?\d)[\s./-]+([A-Za-z]{3,9})[\s./-]+((?:19|20)\d{2})\b/.exec(s);
    if (m) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mon !== undefined) {
        const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
        if (!Number.isNaN(d.getTime())) return { deadline: d.toISOString().slice(0, 10), evidence: s };
      }
    }
    m = /\b([0-3]?\d)[./-]([01]?\d)[./-]((?:19|20)\d{2})\b/.exec(s);
    if (m) {
      const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
      if (!Number.isNaN(d.getTime())) return { deadline: d.toISOString().slice(0, 10), evidence: s };
    }
  }
  return null;
}

/** Required documents, from a documents section or bullet list. */
export function extractDocuments(text) {
  const known = [
    [/aadhaar|aadhar/i, 'Aadhaar card'],
    [/income\s+certificate/i, 'Income certificate'],
    [/caste\s+certificate|community\s+certificate/i, 'Caste / community certificate'],
    [/domicile|residence\s+certificate|bonafide/i, 'Domicile / bonafide certificate'],
    [/mark\s*sheet|marksheet|transcript|grade\s*card/i, 'Latest marksheet'],
    [/bank\s+(?:account|passbook|details)|ifsc/i, 'Bank passbook (with IFSC)'],
    [/passport\s*[\s-]?size\s*photo|photograph/i, 'Passport-size photograph'],
    [/disability\s+certificate/i, 'Disability certificate'],
    [/fee\s+receipt|tuition\s+fee/i, 'Fee receipt'],
    [/admission\s+letter|allotment\s+letter/i, 'Admission letter'],
  ];
  const found = new Set();
  for (const s of sentences(text)) {
    for (const [re, label] of known) {
      if (re.test(s)) found.add(label);
    }
  }
  return [...found];
}

/** Ministry / department attribution. */
export function extractMinistry(text) {
  for (const s of sentences(text).slice(0, 60)) {
    const m = /((?:Ministry|Department|Directorate)\s+of\s+[A-Z][A-Za-z&,\s]{3,60}?)(?:\s*,|\s*\.|\s*Government|\s*$)/.exec(s);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * Runs every extractor and returns structured eligibility plus the evidence
 * sentences and a confidence score based on how much we actually recognised.
 */
export function extractAll(text) {
  const evidence = [];
  const record = (result, key) => {
    if (result?.evidence) evidence.push({ field: key, text: result.evidence });
    return result;
  };

  const income = record(extractIncomeCeiling(text), 'maxFamilyIncome');
  const categories = record(extractCategories(text), 'categories');
  const gender = record(extractGender(text), 'gender');
  const disability = record(extractDisability(text), 'disabilityRequired');
  const levels = record(extractCourseLevels(text), 'courseLevels');
  const marks = record(extractMinMarks(text), 'minMarksPercent');
  const states = record(extractStates(text), 'states');
  const benefit = record(extractBenefit(text), 'benefit');
  const deadline = record(extractDeadline(text), 'deadline');

  const eligibility = {
    maxFamilyIncome: income?.maxFamilyIncome ?? null,
    categories: categories?.categories ?? [],
    gender: gender?.gender ?? [],
    disabilityRequired: disability?.disabilityRequired ?? false,
    courseLevels: levels?.courseLevels ?? [],
    minMarksPercent: marks?.minMarksPercent ?? null,
    states: states?.states ?? [],
  };

  // Confidence reflects how many independent criteria we could actually read.
  const signals = [
    eligibility.maxFamilyIncome !== null,
    eligibility.categories.length > 0,
    eligibility.courseLevels.length > 0,
    benefit !== null,
    deadline !== null,
    extractDocuments(text).length > 0,
  ];
  const confidence = Number((signals.filter(Boolean).length / signals.length).toFixed(2));

  return {
    eligibility,
    benefit: benefit
      ? { min: benefit.benefitMin, max: benefit.benefitMax, period: benefit.benefitPeriod }
      : null,
    deadline: deadline?.deadline ?? null,
    documents: extractDocuments(text),
    ministry: extractMinistry(text),
    evidence,
    confidence,
  };
}
