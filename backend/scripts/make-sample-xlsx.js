#!/usr/bin/env node
/**
 * Writes a small, valid .xlsx so the institute upload can be tested with a real
 * Excel file (and so parseXlsx has something to be tested against).
 *
 *   node scripts/make-sample-xlsx.js [outfile]
 *
 * Deliberately uses deflate (ZIP method 8) and a shared-string table, because
 * that is what Excel itself produces — a stored/uncompressed fixture would test
 * the easy path only.
 */

import { deflateRawSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROWS = [
  ['Student Name', 'Roll No', 'Class', 'State', 'Category', 'Annual Income', 'Gender'],
  ['Ananya Sharma', 'SXC-2027-001', 'Class 11-12', 'Assam', 'ST', '90000', 'Female'],
  ['Rahul Verma', 'SXC-2027-002', 'Undergraduate', 'Rajasthan', 'OBC', '240000', 'Male'],
  ['Priya Patil', 'SXC-2027-003', 'Class 9-10', 'Maharashtra', 'SC', '150000', 'Female'],
  ['Imran Sheikh', 'SXC-2027-004', 'Postgraduate', 'Delhi', 'Minority', '420000', 'Male'],
  ['Meera Nair', 'SXC-2027-005', 'PhD', 'Kerala', 'General', '900000', 'Female'],
];

// ---------------------------------------------------------------- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------ ZIP writer ---
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x21, 12);        // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    locals.push(local, compressed);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------- xlsx parts -----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
};

// Build a shared-string table, exactly as Excel does for text cells.
const shared = [];
const sharedIndex = new Map();
for (const row of ROWS) {
  for (const cell of row) {
    if (/^\d+(\.\d+)?$/.test(cell)) continue; // numbers stay inline
    if (!sharedIndex.has(cell)) { sharedIndex.set(cell, shared.length); shared.push(cell); }
  }
}

const sheetRows = ROWS.map((row, r) => {
  const cells = row.map((cell, c) => {
    const ref = `${colName(c)}${r + 1}`;
    if (/^\d+(\.\d+)?$/.test(cell)) return `<c r="${ref}"><v>${cell}</v></c>`;
    return `<c r="${ref}" t="s"><v>${sharedIndex.get(cell)}</v></c>`;
  }).join('');
  return `<row r="${r + 1}">${cells}</row>`;
}).join('');

const files = [
  {
    name: '[Content_Types].xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`, 'utf8'),
  },
  {
    name: '_rels/.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'),
  },
  {
    name: 'xl/workbook.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Students" sheetId="1" r:id="rId1"/></sheets>
</workbook>`, 'utf8'),
  },
  {
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`, 'utf8'),
  },
  {
    name: 'xl/sharedStrings.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}
</sst>`, 'utf8'),
  },
  {
    name: 'xl/worksheets/sheet1.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRows}</sheetData>
</worksheet>`, 'utf8'),
  },
];

const out = process.argv[2] || path.join(process.cwd(), 'sample-batch.xlsx');
await writeFile(out, buildZip(files));
console.log(`\n  Wrote ${out}`);
console.log(`  ${ROWS.length - 1} students, ${ROWS[0].length} columns.\n`);
