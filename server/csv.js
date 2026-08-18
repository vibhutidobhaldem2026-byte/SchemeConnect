/**
 * CSV parsing and column mapping for institute batch uploads.
 *
 * A real parser rather than split(',') — institute exports routinely contain
 * quoted fields with commas in addresses and course names.
 */

/** RFC-4180-ish parser: handles quotes, escaped quotes and embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text).replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field.trim()); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  row.push(field.trim());
  if (row.some((c) => c !== '')) rows.push(row);

  if (!rows.length) return { headers: [], rows: [] };
  return { headers: rows[0], rows: rows.slice(1) };
}

export const FIELD_OPTIONS = [
  'Ignore column',
  'Student name',
  'Student ID',
  'Class / course',
  'State',
  'Category',
  'Annual income',
  'Gender',
  'Disability',
];

const GUESSES = [
  [/^(student\s*)?name|full\s*name/i, 'Student name'],
  [/roll|student\s*(id|no)|enrol|reg(istration)?\s*(no|number)|^id$/i, 'Student ID'],
  [/class|course|year|grade|standard|programme|program/i, 'Class / course'],
  [/state|domicile/i, 'State'],
  [/categ|caste|community|social/i, 'Category'],
  [/income|salary|earning/i, 'Annual income'],
  [/gender|sex/i, 'Gender'],
  [/disab|divyang|pwd/i, 'Disability'],
];

export function guessMapping(headers) {
  return headers.map((header) => {
    const match = GUESSES.find(([re]) => re.test(header));
    return { header, field: match ? match[1] : 'Ignore column' };
  });
}

/** Normalises a free-text class/course value onto our course levels. */
function normaliseCourse(value) {
  const v = String(value || '').toLowerCase();
  if (/\b(9|ix|10|x)\b|pre.?matric/.test(v)) return 'Class 9-10';
  if (/\b(11|xi|12|xii)\b|inter|higher\s*sec|senior\s*sec|post.?matric/.test(v)) return 'Class 11-12';
  if (/diploma|polytechnic|iti/.test(v)) return 'Diploma';
  if (/ph\.?d|doctoral/.test(v)) return 'PhD';
  if (/\b(pg|m\.?tech|m\.?sc|m\.?a\b|m\.?com|master|post.?grad)/.test(v)) return 'Postgraduate';
  if (/\b(ug|b\.?tech|b\.?sc|b\.?a\b|b\.?com|bachelor|under.?grad|degree)/.test(v)) return 'Undergraduate';
  return null;
}

function normaliseCategory(value) {
  const v = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (['SC', 'SCHEDULEDCASTE'].includes(v)) return 'SC';
  if (['ST', 'SCHEDULEDTRIBE'].includes(v)) return 'ST';
  if (['OBC', 'BC', 'OTHERBACKWARDCLASS'].includes(v)) return 'OBC';
  if (['EWS'].includes(v)) return 'EWS';
  if (['MINORITY', 'MIN'].includes(v)) return 'Minority';
  if (['GEN', 'GENERAL', 'UR'].includes(v)) return 'General';
  return null;
}

/** Maps a raw rupee figure onto the income band the matcher understands. */
function normaliseIncome(value) {
  const raw = String(value || '').toLowerCase().replace(/[₹,\s]/g, '');
  if (!raw) return null;
  let n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  if (/lakh|lac/.test(String(value).toLowerCase())) n *= 100000;
  if (n <= 100000) return 'below-1l';
  if (n <= 250000) return '1l-2.5l';
  if (n <= 450000) return '2.5l-4.5l';
  if (n <= 800000) return '4.5l-8l';
  return 'above-8l';
}

function normaliseGender(value) {
  const v = String(value || '').toLowerCase();
  if (/^f|female|girl|woman/.test(v)) return 'Female';
  if (/^m|male|boy|man/.test(v)) return 'Male';
  if (!v) return null;
  return 'Other';
}

function normaliseState(value) {
  const v = String(value || '').trim();
  return v.length >= 3 ? v.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

/**
 * Turns mapped CSV rows into student records with a matcher-ready profile.
 * Unmapped or unparseable values become null — never a guess, because a wrong
 * guess here produces a wrong match for a real student.
 */
export function rowsToStudents(rows, mapping) {
  const indexOf = (field) => mapping.findIndex((m) => m.field === field);

  const iName = indexOf('Student name');
  const iId = indexOf('Student ID');
  const iCourse = indexOf('Class / course');
  const iState = indexOf('State');
  const iCategory = indexOf('Category');
  const iIncome = indexOf('Annual income');
  const iGender = indexOf('Gender');
  const iDisability = indexOf('Disability');

  const at = (row, i) => (i >= 0 ? row[i] : null);

  return rows
    .map((row) => {
      const name = String(at(row, iName) || '').trim();
      if (!name) return null;
      const disabilityRaw = String(at(row, iDisability) || '').toLowerCase();
      return {
        name,
        studentId: String(at(row, iId) || '').trim() || null,
        profile: {
          state: normaliseState(at(row, iState)),
          courseLevel: normaliseCourse(at(row, iCourse)),
          category: normaliseCategory(at(row, iCategory)),
          income: normaliseIncome(at(row, iIncome)),
          gender: normaliseGender(at(row, iGender)),
          disability: /^(y|yes|true|1)$/.test(disabilityRaw)
            ? true
            : /^(n|no|false|0)$/.test(disabilityRaw) ? false : null,
        },
        matchCount: 0,
      };
    })
    .filter(Boolean);
}
