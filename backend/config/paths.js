import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The backend package root — everything server-side resolves from here. */
export const ROOT = path.resolve(here, '..');

/** The repository root, one level up. Only the frontend lives outside ROOT. */
export const REPO_ROOT = path.resolve(ROOT, '..');

export const DATA_DIR = path.join(ROOT, 'data');
export const CATALOG_DIR = path.join(DATA_DIR, 'catalog');
export const CATALOG_FILE = path.join(CATALOG_DIR, 'schemes.json');
export const RUN_LOG_FILE = path.join(CATALOG_DIR, 'scrape-runs.json');
export const COVERAGE_FILE = path.join(CATALOG_DIR, 'coverage.json');
export const CACHE_DIR = path.join(DATA_DIR, '.cache');
export const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

/**
 * Static assets, which now live outside the backend in frontend/.
 *
 * The backend serves them itself: this app renders its HTML on the server, so
 * the CSS and JS belong to the same origin as the pages that reference them.
 * Putting them behind a second host would cost an extra DNS lookup and TLS
 * handshake for 20 KB and buy nothing — on the 2G/3G connections PRD §4 targets
 * it would be a straight loss.
 *
 * FRONTEND_DIR overrides the location for a deployment that lays the repository
 * out differently.
 */
export const PUBLIC_DIR = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.join(REPO_ROOT, 'frontend');
