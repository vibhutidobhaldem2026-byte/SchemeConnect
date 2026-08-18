/**
 * Minimal .xlsx reader.
 *
 * An .xlsx file is a ZIP archive of XML parts. Node ships zlib, so the whole
 * thing can be read without adding a dependency — which matters here because
 * the popular spreadsheet libraries are large and have a poor CVE history for
 * something that parses untrusted institute uploads.
 *
 * We read only what a batch import needs: the first worksheet's cell values,
 * resolved against the shared-string table. Formatting, formulas, charts and
 * merged cells are ignored.
 */

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class XlsxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XlsxError';
  }
}

/** Locates the End Of Central Directory record, scanning back from the tail. */
function findEocd(buf) {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - maxComment - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Reads the ZIP central directory and returns the entries we care about.
 * @returns {Map<string, {offset:number, method:number, compressedSize:number, size:number}>}
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new XlsxError('Not a valid .xlsx file (no ZIP end-of-directory record).');

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields are saturated and the real values live elsewhere.
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === SIG_EOCD64_LOCATOR) {
      const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
      entryCount = Number(buf.readBigUInt64LE(eocd64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
    } else {
      throw new XlsxError('This .xlsx uses ZIP64 without a locator record and cannot be read.');
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { offset: localOffset, method, compressedSize, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extracts one entry's bytes. */
function readEntry(buf, entry) {
  if (!entry) return null;
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new XlsxError('Corrupt .xlsx (bad local file header).');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch (err) {
      throw new XlsxError(`Could not decompress the spreadsheet (${err.message}).`);
    }
  }
  throw new XlsxError(`Unsupported ZIP compression method ${entry.method} in this .xlsx.`);
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => XML_ENTITIES[n]);
}

/**
 * Shared strings table. Each <si> may hold several <t> runs (rich text), which
 * concatenate into one value — a cell styled mid-word would otherwise lose
 * half its text.
 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1] ?? '';
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner))) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

/** "AB" -> 27 (zero-based column index). */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref).toUpperCase());
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Excel stores dates as a serial number with a style, not a typed value.
 * We deliberately do NOT convert: the batch importer reads names, IDs, classes,
 * states, categories and incomes, none of which are dates, and a wrong guess
 * would turn a valid roll number into a date. Numbers come through verbatim.
 */
function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rowMatch;

  while ((rowMatch = rowRe.exec(xml))) {
    const inner = rowMatch[1] ?? '';
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;

    while ((cellMatch = cellRe.exec(inner))) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const type = /t="([^"]+)"/i.exec(attrs)?.[1] || 'n';
      const col = ref ? columnIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1);
        value = sharedStrings[idx] ?? '';
      } else if (type === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(body))) value += decodeXml(t[1]);
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      while (cells.length < col) cells.push(''); // preserve empty columns
      cells[col] = String(value).trim();
    }
    rows.push(cells);
  }
  return rows;
}

/** Picks the sheet the workbook lists first, falling back to any worksheet. */
function firstSheetPath(entries, buf) {
  const workbook = readEntry(buf, entries.get('xl/workbook.xml'));
  const rels = readEntry(buf, entries.get('xl/_rels/workbook.xml.rels'));

  if (workbook && rels) {
    const firstId = /<sheet\b[^>]*r:id="([^"]+)"/i.exec(workbook.toString('utf8'))?.[1];
    if (firstId) {
      const relRe = new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`, 'i');
      const target = relRe.exec(rels.toString('utf8'))?.[1];
      if (target) {
        const clean = target.replace(/^\/?xl\//, '').replace(/^\//, '');
        if (entries.has(`xl/${clean}`)) return `xl/${clean}`;
      }
    }
  }
  if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  return [...entries.keys()].find((k) => /^xl\/worksheets\/.*\.xml$/.test(k)) ?? null;
}

/**
 * Reads an .xlsx buffer into the same shape parseCsv() returns.
 * @param {Buffer} buffer
 * @returns {{headers: string[], rows: string[][]}}
 */
export function parseXlsx(buffer) {
  if (!buffer || buffer.length < 22) throw new XlsxError('That file is empty or too small to be a spreadsheet.');
  // "PK\x03\x04" — every xlsx is a ZIP. A .xls (old binary format) is not.
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new XlsxError('That does not look like a .xlsx file. If it is an older .xls, re-save it as .xlsx or .csv.');
  }

  const entries = readCentralDirectory(buffer);
  const sheetPath = firstSheetPath(entries, buffer);
  if (!sheetPath) throw new XlsxError('No worksheet found inside the .xlsx file.');

  const shared = parseSharedStrings(readEntry(buffer, entries.get('xl/sharedStrings.xml'))?.toString('utf8'));
  const sheetXml = readEntry(buffer, entries.get(sheetPath))?.toString('utf8');
  if (!sheetXml) throw new XlsxError('The worksheet inside the .xlsx file could not be read.');

  const all = parseSheet(sheetXml, shared).filter((r) => r.some((c) => c !== ''));
  if (!all.length) return { headers: [], rows: [] };

  const headers = all[0].map((h) => String(h).trim());
  const width = headers.length;
  const rows = all.slice(1).map((r) => {
    const row = r.slice(0, width);
    while (row.length < width) row.push('');
    return row;
  });

  return { headers, rows };
}
