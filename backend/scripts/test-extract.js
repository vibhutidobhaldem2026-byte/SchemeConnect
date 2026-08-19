#!/usr/bin/env node
/**
 * Unit tests for the extraction heuristics.
 *
 *   node scripts/test-extract.js
 *
 * These rules decide whether a real student is shown or denied a scheme, so
 * each one is pinned with the government wording that motivated it. The
 * negative cases matter more than the positive ones: a false restriction
 * silently hides a scheme a student qualifies for.
 */

import {
  extractIncomeCeiling, extractCategories, extractGender, extractCourseLevels,
  extractMinMarks, extractDeadline, extractDocuments, parseIndianAmount, extractBenefit,
} from '../scraper/lib/extract.js';
import { looksEducational, validateScheme } from '../scraper/lib/normalize.js';

let pass = 0, fail = 0;
function t(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); }
}

console.log('\n--- parseIndianAmount ---');
t('plain', parseIndianAmount('Rs. 2,50,000'), 250000);
t('lakh word', parseIndianAmount('₹2.5 lakh'), 250000);
t('lac spelling', parseIndianAmount('1 lac'), 100000);
t('crore', parseIndianAmount('1 crore'), 10000000);
t('bare number', parseIndianAmount('90000'), 90000);

console.log('\n--- income ceiling ---');
t('not exceed',
  extractIncomeCeiling('The annual family income should not exceed Rs. 2,50,000 from all sources.')?.maxFamilyIncome,
  250000);
t('lakh form',
  extractIncomeCeiling('Parental income from all sources must not be more than ₹8 lakh per annum.')?.maxFamilyIncome,
  800000);
t('ignores tiny figures',
  extractIncomeCeiling('An annual income of Rs. 500 is charged as fee.'),
  null);

console.log('\n--- categories ---');
t('SC/ST pair',
  extractCategories('Eligible students belonging to Scheduled Castes and Scheduled Tribes may apply.')?.categories.sort(),
  ['SC', 'ST']);
t('OBC',
  extractCategories('The candidate should belong to Other Backward Classes as notified.')?.categories,
  ['OBC']);
t('no category stated',
  extractCategories('The scheme supports meritorious students across the country.'),
  null);

console.log('\n--- gender (the quota trap) ---');
t('rejects earmark quota',
  extractGender('30% of the scholarships for each selection year are earmarked for female candidates.'),
  null);
t('rejects percentage reservation',
  extractGender('Reservation of 33 per cent is provided for women applicants.'),
  null);
t('rejects preference wording',
  extractGender('Preference will be given to female students.'),
  null);
t('accepts genuine restriction',
  extractGender('This scholarship is meant only for girl students of Class IX and X.')?.gender,
  ['Female']);
t('accepts "open only to"',
  extractGender('The scheme is open only to women candidates pursuing postgraduate study.')?.gender,
  ['Female']);
t('rejects mixed wording',
  extractGender('Both boys and girls are eligible to apply under this scheme.'),
  null);

console.log('\n--- course levels ---');
t('pre-matric',
  extractCourseLevels('Students studying in Class IX and X in a recognised school are eligible.')?.courseLevels,
  ['Class 9-10']);
t('post-matric',
  extractCourseLevels('Applicable to students pursuing post-matric courses at higher secondary level.')?.courseLevels.includes('Class 11-12'),
  true);
t('PhD',
  extractCourseLevels('Open to research scholars pursuing Ph.D. in Indian universities.')?.courseLevels,
  ['PhD']);

console.log('\n--- minimum marks ---');
t('not less than',
  extractMinMarks('The applicant must have secured not less than 60% marks in the qualifying examination.')?.minMarksPercent,
  60);
t('ignores implausible',
  extractMinMarks('Around 5% of applicants are selected.'),
  null);

console.log('\n--- deadline ---');
t('textual date',
  extractDeadline('The last date for submission of applications is 31 October 2026.')?.deadline,
  '2026-10-31');
t('numeric date',
  extractDeadline('Applications must be submitted on or before 15/11/2026.')?.deadline,
  '2026-11-15');
t('no deadline',
  extractDeadline('Applications are invited from eligible students.'),
  null);

console.log('\n--- documents ---');
t('finds the usual set',
  extractDocuments('Attach a copy of the income certificate, caste certificate and latest marksheet along with bank passbook details.').sort(),
  ['Bank passbook (with IFSC)', 'Caste / community certificate', 'Income certificate', 'Latest marksheet']);

console.log('\n--- benefit ---');
t('annual amount',
  extractBenefit('A scholarship of Rs. 12,000 per annum is payable to each selected student.')?.benefitMax,
  12000);

// --------------------------------------------------------------------------
// Regressions. Each of these shipped in the catalogue at some point and was
// wrong in a way a student would have seen.

console.log('\n--- course level: false positives ---');
// "B.A / B.Sc / B.E" was matched case-insensitively with the dot and space both
// optional, so it matched the word "be". One sentence about grants to eligible
// agencies read as "this scheme is for Undergraduates", which is how a
// senior-citizens scheme came to be recommended to students.
t('the word "be" is not a degree',
  extractCourseLevels('Assistance will be given to the Implementing Agencies such as eligible Non-Governmental Organizations.'),
  null);
t('the word "me" is not a degree',
  extractCourseLevels('The list mentioned above was sent to me by the eligible State Government.'),
  null);
t('"eligible" alone does not admit a sentence',
  extractCourseLevels('Eligible organisations may be reimbursed for expenditure incurred.'),
  null);

console.log('\n--- course level: real wording still reads ---');
t('class 9-10', extractCourseLevels('The student must be studying in Class IX or X.')?.courseLevels, ['Class 9-10']);
t('B.Tech', extractCourseLevels('Open to candidates pursuing B.Tech at a recognised university.')?.courseLevels, ['Undergraduate']);
t('undotted BSc', extractCourseLevels('Students enrolled in BSc programmes may apply.')?.courseLevels, ['Undergraduate']);
t('PhD', extractCourseLevels('Applicants enrolled in a Ph.D programme are eligible.')?.courseLevels, ['PhD']);
t('postgraduate', extractCourseLevels('Scholarship for students pursuing post-graduate courses.')?.courseLevels, ['Postgraduate']);

console.log('\n--- relevance: this is a catalogue for students ---');
// The crawl reaches every central DBT scheme, most of which are nothing to do
// with education. Each of these was in the catalogue a student was browsing.
t('pension scheme rejected', looksEducational({ name: 'Coal Mines Pension Scheme-1998' }), false);
t('health insurance rejected', looksEducational({ name: 'Ayushman Bharat - Pradhan Mantri Jan Arogya Yojana' }), false);
t('senior citizens scheme rejected', looksEducational({ name: 'Atal Vayo Abhyuday Yojana (AVYAY)' }), false);
t('vehicle subsidy rejected', looksEducational({ name: 'Demand Incentive under FAME India Scheme' }), false);
t('scholarship accepted', looksEducational({ name: 'Post-Matric Scholarship for SC students' }), true);
t('fellowship accepted', looksEducational({ name: 'National Fellowship for OBC Students' }), true);
// An opaque name is rescued by what the page itself said.
t('opaque name, educational evidence',
  looksEducational({ name: 'PM-DAKSH Yojana',
    criteriaEvidence: [{ field: 'categories', text: 'For non-residential training programmes, trainees will be paid a stipend.' }] }),
  true);


console.log('\n--- notices and navigation are not schemes ---');
// Each of these was live in the catalogue as a scheme. They pass every other
// test — right words, right domain, real page — and one was even matchable, so
// a results list was being offered to students as something to qualify for.
const notScheme = (name) =>
  validateScheme({ name, source: { url: 'https://x.gov.in/a' }, eligibility: {}, detailLevel: 'listing' })
    .problems.some((p) => p.includes('notice or a navigation'));

for (const name of [
  'List of provisionally selected candidates for the year 2026',
  'Amended list of provisionally selected candidates',
  'Ministry invites online applications for National Overseas Scholarship',
  'Online application invited for National Fellowship',
  'List of Applicants Processed for Scholarships',
  'List of the selected students under AICTE Saraswati Scholarship',
  'Apply For Scholarship',
  'Nodal Officers (Scheme-wise)',
  'Scholarship Eligibility',
]) t('rejected: ' + name.slice(0, 40), notScheme(name), true);

console.log('\n--- real scheme names still pass that filter ---');
for (const name of [
  'Post-Matric Scholarship for SC students',
  'National Overseas Scholarship for Scheduled Caste Candidates',
  'Pre-Matric Scholarship Scheme for ST students',
  'AICTE Pragati Scholarship Scheme for Girl Students',
]) t('kept: ' + name.slice(0, 40), notScheme(name), false);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exitCode = fail ? 1 : 0;
