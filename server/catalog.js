/**
 * Reads the scraper's output. This is the website's only source of scheme data —
 * nothing here is hand-authored, and if the scraper has never run the site
 * says so rather than inventing content.
 */

import { readFile } from 'node:fs/promises';
import { CATALOG_FILE, COVERAGE_FILE, RUN_LOG_FILE } from '../config/paths.js';

let cache = { catalog: null, coverage: null, runs: null, loadedAt: 0 };
const TTL_MS = 5000; // short, so a fresh scrape shows up without a restart

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function load() {
  if (cache.catalog && Date.now() - cache.loadedAt < TTL_MS) return cache;

  const catalog = await readJson(CATALOG_FILE, null);
  const coverage = await readJson(COVERAGE_FILE, null);
  const runs = await readJson(RUN_LOG_FILE, []);

  cache = { catalog, coverage, runs, loadedAt: Date.now() };
  return cache;
}

/** Every scheme in the catalog, both tiers. */
export async function allSchemes() {
  const { catalog } = await load();
  return catalog?.schemes ?? [];
}

/** Only schemes whose criteria we actually read — the matchable set. */
export async function matchableSchemes() {
  return (await allSchemes()).filter((s) => s.detailLevel === 'full');
}

export async function getScheme(id) {
  return (await allSchemes()).find((s) => s.id === id || s.slug === id) ?? null;
}

export async function catalogMeta() {
  const { catalog, coverage, runs } = await load();
  const schemes = catalog?.schemes ?? [];
  return {
    exists: Boolean(catalog),
    generatedAt: catalog?.generatedAt ?? null,
    total: schemes.length,
    matchable: schemes.filter((s) => s.detailLevel === 'full').length,
    listingOnly: schemes.filter((s) => s.detailLevel === 'listing').length,
    central: schemes.filter((s) => s.level === 'central').length,
    state: schemes.filter((s) => s.level === 'state').length,
    withDeadline: schemes.filter((s) => s.deadline).length,
    sources: [...new Set(schemes.map((s) => s.source?.domain).filter(Boolean))],
    coverage,
    lastRun: runs?.[0] ?? null,
    runs: runs ?? [],
  };
}

/** Age of the catalog in days — drives the staleness banner. */
export async function catalogAgeDays() {
  const { catalog } = await load();
  if (!catalog?.generatedAt) return null;
  return Math.floor((Date.now() - new Date(catalog.generatedAt).getTime()) / 86400000);
}

/**
 * States we can serve. Per the PRD, a student in an uncovered state is told we
 * have no verified data rather than shown an empty list they might read as
 * "you qualify for nothing".
 */
export async function stateCoverage(state) {
  const { coverage } = await load();
  if (!coverage) return { known: false, hasStateSchemes: false, centralSchemes: 0 };
  const entry = coverage.perState?.find((e) => e.state === state);
  return {
    known: Boolean(entry),
    hasStateSchemes: (entry?.schemes ?? 0) > 0,
    centralSchemes: coverage.centralSchemes ?? 0,
    stateSchemes: entry?.schemes ?? 0,
  };
}

export function invalidateCatalogCache() {
  cache = { catalog: null, coverage: null, runs: null, loadedAt: 0 };
}
