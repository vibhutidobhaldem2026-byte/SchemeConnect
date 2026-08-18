/**
 * On-disk response cache.
 *
 * Keeps repeated scraper runs from re-hitting government servers during
 * development. Cache entries are keyed by URL hash and carry the fetch
 * timestamp so provenance survives a cache hit.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from '../../config/paths.js';

function keyFor(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function pathsFor(url, binary) {
  const key = keyFor(url);
  return {
    meta: path.join(CACHE_DIR, `${key}.json`),
    body: path.join(CACHE_DIR, `${key}${binary ? '.bin' : '.txt'}`),
  };
}

export async function readCache(url, { binary = false, maxAgeMs = Infinity } = {}) {
  const { meta, body } = pathsFor(url, binary);
  try {
    const metaRaw = await readFile(meta, 'utf8');
    const parsed = JSON.parse(metaRaw);
    const age = Date.now() - new Date(parsed.fetchedAt).getTime();
    if (age > maxAgeMs) return null;
    const content = binary ? await readFile(body) : await readFile(body, 'utf8');
    return {
      status: parsed.status,
      contentType: parsed.contentType,
      fetchedAt: parsed.fetchedAt,
      body: content,
    };
  } catch {
    return null;
  }
}

export async function writeCache(url, result, { binary = false } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const { meta, body } = pathsFor(url, binary);
  await writeFile(
    meta,
    JSON.stringify(
      { url, status: result.status, contentType: result.contentType, fetchedAt: result.fetchedAt },
      null,
      2
    ),
    'utf8'
  );
  if (binary) await writeFile(body, result.body);
  else await writeFile(body, result.body, 'utf8');
}

export async function clearCache() {
  await rm(CACHE_DIR, { recursive: true, force: true });
}

export async function cacheStats() {
  try {
    const files = await readdir(CACHE_DIR);
    let bytes = 0;
    for (const f of files) {
      const s = await stat(path.join(CACHE_DIR, f));
      bytes += s.size;
    }
    return { entries: Math.floor(files.length / 2), bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}
