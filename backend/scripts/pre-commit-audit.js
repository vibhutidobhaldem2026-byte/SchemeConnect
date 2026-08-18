#!/usr/bin/env node
/**
 * Pre-commit audit: what would actually be pushed, and does any of it contain
 * something that must never leave this machine?
 *
 *   node scripts/pre-commit-audit.js
 *
 * Applies the .gitignore rules and then scans every file that survives them for
 * credential-shaped strings. Run this before the first push to a public repo.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../config/paths.js';

/** Minimal .gitignore matcher — enough for the patterns this project uses. */
async function loadIgnoreRules() {
  let text = '';
  try {
    text = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((pattern) => {
      const dirOnly = pattern.endsWith('/');
      const clean = dirOnly ? pattern.slice(0, -1) : pattern;
      const rx = clean
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');
      return { raw: pattern, dirOnly, re: new RegExp(`(^|/)${rx}(/|$)`) };
    });
}

function isIgnored(relPath, rules) {
  const normalised = relPath.split(path.sep).join('/');
  return rules.find((r) => r.re.test(normalised)) ?? null;
}

/** Things that must never reach a public repository. */
const SECRET_PATTERNS = [
  [/re_[A-Za-z0-9_-]{20,}/, 'Resend API key'],
  [/sk-[A-Za-z0-9]{20,}/, 'OpenAI-style secret key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/"password"\s*:\s*"[^"]{6,}"/i, 'hardcoded password'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
];

const SKIP_SCAN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.xlsx', '.zip', '.ico', '.woff', '.woff2']);

const included = [];
const ignored = [];
const findings = [];

async function walk(dir, rules) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);

    if (entry.name === '.git') continue;

    const rule = isIgnored(rel, rules);
    if (rule) {
      ignored.push({ rel, rule: rule.raw, dir: entry.isDirectory() });
      continue;
    }

    if (entry.isDirectory()) {
      await walk(full, rules);
      continue;
    }

    const info = await stat(full);
    included.push({ rel, size: info.size });

    if (SKIP_SCAN_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    if (info.size > 2 * 1024 * 1024) continue;

    const content = await readFile(full, 'utf8').catch(() => '');
    for (const [re, label] of SECRET_PATTERNS) {
      const m = re.exec(content);
      if (m) findings.push({ rel, label, sample: m[0].slice(0, 12) + '…' });
    }
  }
}

const rules = await loadIgnoreRules();
await walk(ROOT, rules);

const totalBytes = included.reduce((n, f) => n + f.size, 0);

console.log('');
console.log('  EXCLUDED by .gitignore');
const seenRules = new Map();
for (const i of ignored) {
  seenRules.set(i.rule, (seenRules.get(i.rule) ?? 0) + 1);
}
for (const [rule, n] of seenRules) console.log(`    ${rule.padEnd(24)} ${n} path(s)`);

console.log('');
console.log(`  WOULD BE COMMITTED — ${included.length} files, ${(totalBytes / 1024).toFixed(0)} KB`);
const byDir = new Map();
for (const f of included) {
  const top = f.rel.split(path.sep)[0];
  const key = f.rel.includes(path.sep) ? top + '/' : '(root)';
  byDir.set(key, (byDir.get(key) ?? 0) + 1);
}
for (const [d, n] of [...byDir].sort()) console.log(`    ${d.padEnd(24)} ${n} file(s)`);

const big = included.filter((f) => f.size > 512 * 1024).sort((a, b) => b.size - a.size);
if (big.length) {
  console.log('');
  console.log('  LARGE FILES (review before committing)');
  for (const f of big) console.log(`    ${(f.size / 1024).toFixed(0).padStart(6)} KB  ${f.rel}`);
}

console.log('');
if (findings.length) {
  console.log('  *** SECRETS DETECTED — DO NOT PUSH ***');
  for (const f of findings) console.log(`    ${f.label} in ${f.rel}  (${f.sample})`);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('  SECRET SCAN: clean — no credential-shaped strings in any committed file.');
  console.log('');
}
