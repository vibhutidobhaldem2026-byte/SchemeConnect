/**
 * Government PDF circular adapter.
 *
 * Scheme guidelines are published as PDFs far more often than as structured
 * pages, so this adapter carries most of the real eligibility detail. Text is
 * extracted with pdftotext -layout, which keeps eligibility tables readable.
 */

import { govFetch } from '../lib/httpClient.js';
import { pdfToText, isPdfToTextAvailable } from '../lib/pdf.js';
import { extractAll } from '../lib/extract.js';
import { toScheme } from '../lib/normalize.js';
import { log } from '../lib/log.js';

export const id = 'gov-pdf';

let availabilityChecked = false;
let available = false;

async function ensureAvailable() {
  if (!availabilityChecked) {
    available = await isPdfToTextAvailable();
    availabilityChecked = true;
    if (!available) {
      log.warn('pdftotext not found — PDF sources will be skipped. Install poppler to enable them.');
    }
  }
  return available;
}

/** Derives a scheme name from the PDF's own first heading-ish line. */
function nameFromText(text, fallback) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 12 && l.length < 160);

  for (const line of lines.slice(0, 40)) {
    if (/scheme|scholarship|fellowship|stipend|yojana/i.test(line)
      && !/^(annexure|appendix|table|page|form|no\.)/i.test(line)) {
      return line.replace(/^[\d.\s)-]+/, '').trim();
    }
  }
  return fallback;
}

export async function extract(candidate) {
  if (!(await ensureAvailable())) {
    return { scheme: null, error: 'pdftotext unavailable' };
  }

  let res;
  try {
    res = await govFetch(candidate.url, { binary: true, accept: 'application/pdf,*/*' });
  } catch (err) {
    return { scheme: null, error: err.message };
  }
  if (!res.ok) return { scheme: null, error: `HTTP ${res.status}` };

  const { text, pages, error } = await pdfToText(res.body);
  if (error) return { scheme: null, error: `pdf parse: ${error}` };
  if (!text || text.length < 400) {
    return { scheme: null, error: `PDF text too short (${text.length} chars) — likely a scanned image` };
  }

  const extracted = extractAll(text);
  const name = nameFromText(text, candidate.title);

  const scheme = toScheme({
    name,
    summary: text.replace(/\s+/g, ' ').slice(0, 300),
    sourceUrl: res.url,
    adapter: id,
    docType: 'pdf',
    rawText: text,
    extracted,
    level: candidate.level,
    state: candidate.state,
    fetchedAt: res.fetchedAt,
  });

  scheme.source.pages = pages;
  return { scheme, error: null };
}

export default { id, extract };
