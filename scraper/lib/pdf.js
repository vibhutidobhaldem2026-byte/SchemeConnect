/**
 * PDF text extraction via poppler's pdftotext.
 *
 * Government scheme guidelines are published overwhelmingly as PDF circulars,
 * so this is a first-class source type rather than a fallback. We shell out to
 * pdftotext because it handles the layout-preserving extraction that makes
 * eligibility tables readable, and it avoids a native npm dependency.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/** Common install locations, so a stale PATH in the parent shell isn't fatal. */
const CANDIDATE_DIRS = [
  process.env.POPPLER_BIN,
  path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin'
  ),
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
].filter(Boolean);

let resolvedBinary = null;

function resolvePdfToText() {
  if (resolvedBinary) return resolvedBinary;
  const exe = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
  for (const dir of CANDIDATE_DIRS) {
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) {
      resolvedBinary = candidate;
      return resolvedBinary;
    }
  }
  resolvedBinary = 'pdftotext'; // fall back to PATH
  return resolvedBinary;
}

export async function isPdfToTextAvailable() {
  try {
    await execFileAsync(resolvePdfToText(), ['-v'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts text from a PDF buffer.
 * @param {Buffer} buffer
 * @param {{layout?: boolean, maxPages?: number}} opts
 * @returns {Promise<{text: string, pages: number|null}>}
 */
export async function pdfToText(buffer, { layout = true, maxPages = 40 } = {}) {
  if (!buffer || buffer.length === 0) return { text: '', pages: 0 };
  // Guard against HTML error pages served with a .pdf URL.
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { text: '', pages: 0, error: 'not a PDF (missing %PDF- header)' };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'sc-pdf-'));
  const inFile = path.join(dir, 'doc.pdf');
  const outFile = path.join(dir, 'doc.txt');
  try {
    await writeFile(inFile, buffer);
    const args = [];
    if (layout) args.push('-layout');
    if (maxPages) args.push('-l', String(maxPages));
    args.push('-enc', 'UTF-8', inFile, outFile);
    await execFileAsync(resolvePdfToText(), args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const text = await readFile(outFile, 'utf8');
    return { text: text.replace(/\f/g, '\n'), pages: countPages(buffer) };
  } catch (err) {
    return { text: '', pages: null, error: err.message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function countPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}
