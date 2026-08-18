#!/usr/bin/env node
/**
 * Sanity check for the matching engine against the real scraped catalog.
 *
 *   node scripts/check-matching.js
 *
 * Prints what each matchable scheme actually requires, then runs a few
 * representative student profiles through the matcher. A catalog where nobody
 * matches anything usually means the extractors are over-reading criteria, not
 * that the students are ineligible — this is how you tell the two apart.
 */

import path from 'node:path';
import { ROOT } from '../config/paths.js';
import { matchableSchemes, allSchemes } from '../server/catalog.js';
import { matchProfile, evaluateScheme } from '../server/matcher.js';
import { close } from '../server/db.js';

// The catalogue lives in PostgreSQL now, so this needs a connection.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // DATABASE_URL may come from the environment.
}

const schemes = await matchableSchemes();
const all = await allSchemes();

console.log(`\nCatalog: ${all.length} schemes, ${schemes.length} with machine-readable criteria\n`);
console.log('Criteria the matcher can see:\n');

for (const s of schemes) {
  const e = s.eligibility;
  const bits = [];
  if (e.maxFamilyIncome !== null) bits.push(`income<=₹${e.maxFamilyIncome.toLocaleString('en-IN')}`);
  if (e.categories.length) bits.push(`cat:${e.categories.join('/')}`);
  if (e.courseLevels.length) bits.push(`level:${e.courseLevels.join('/')}`);
  if (e.gender.length) bits.push(`gender:${e.gender.join('/')}`);
  if (e.disabilityRequired) bits.push('disability required');
  if (e.minMarksPercent !== null) bits.push(`marks>=${e.minMarksPercent}%`);
  if (e.states.length) bits.push(`states:${e.states.join('/')}`);
  console.log(`  ${s.name.slice(0, 62).padEnd(64)} ${bits.join(', ') || '(none)'}`);
}

const PROFILES = {
  'Assam / Class 11-12 / ST / below 1L / Female': {
    state: 'Assam', courseLevel: 'Class 11-12', category: 'ST', income: 'below-1l', gender: 'Female', disability: false,
  },
  'Rajasthan / UG / OBC / 1-2.5L / Male': {
    state: 'Rajasthan', courseLevel: 'Undergraduate', category: 'OBC', income: '1l-2.5l', gender: 'Male', disability: false,
  },
  'Delhi / PG / SC / 2.5-4.5L / Female': {
    state: 'Delhi', courseLevel: 'Postgraduate', category: 'SC', income: '2.5l-4.5l', gender: 'Female', disability: false,
  },
  'Kerala / Class 9-10 / General / above 8L / Male': {
    state: 'Kerala', courseLevel: 'Class 9-10', category: 'General', income: 'above-8l', gender: 'Male', disability: false,
  },
  'Bihar / UG / SC / below 1L / Male + disability': {
    state: 'Bihar', courseLevel: 'Undergraduate', category: 'SC', income: 'below-1l', gender: 'Male', disability: true,
  },
};

console.log('\nMatching results:\n');
let anyMatched = false;
for (const [label, profile] of Object.entries(PROFILES)) {
  const { matches, nearMisses } = matchProfile(schemes, profile);
  if (matches.length) anyMatched = true;
  console.log(`  ${label}`);
  console.log(`    ${matches.length} match(es), ${nearMisses.length} near miss(es)`);
  for (const m of matches.slice(0, 4)) {
    console.log(`      + ${m.scheme.name.slice(0, 60)}`);
    console.log(`        passed: ${m.passed.map((p) => p.label).join(', ') || '—'}`);
  }
  for (const n of nearMisses.slice(0, 2)) {
    console.log(`      - ${n.scheme.name.slice(0, 60)}`);
    console.log(`        blocked by ${n.blockedBy.label}: ${n.blockedBy.detail.slice(0, 90)}`);
  }
  console.log('');
}

if (!anyMatched) {
  console.log('  WARNING: no profile matched any scheme. Check the extractors.\n');
  process.exitCode = 1;
}

await close();
