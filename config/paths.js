import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CATALOG_DIR = path.join(DATA_DIR, 'catalog');
export const CATALOG_FILE = path.join(CATALOG_DIR, 'schemes.json');
export const RUN_LOG_FILE = path.join(CATALOG_DIR, 'scrape-runs.json');
export const COVERAGE_FILE = path.join(CATALOG_DIR, 'coverage.json');
export const CACHE_DIR = path.join(DATA_DIR, '.cache');
export const STORE_FILE = path.join(DATA_DIR, 'store.json');
export const PUBLIC_DIR = path.join(ROOT, 'public');
