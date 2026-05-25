import * as fs from 'fs';
import * as path from 'path';
import { Storage } from './storage.js';
import { findProject } from './registry.js';

const MAX = 5;
const TTL_MS = 60_000;

interface CacheEntry {
  storage: Storage;
  lastUsed: number;
}

// Keyed by resolved absolute DB path for stability across cwd changes.
const cache = new Map<string, CacheEntry>();

export function evictIdle(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.lastUsed > TTL_MS) {
      try { entry.storage.close(); } catch { /* ignore */ }
      cache.delete(key);
    }
  }
}

export function evictLru(): void {
  if (cache.size < MAX) return;
  let lruKey = '';
  let lruTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.lastUsed < lruTime) {
      lruTime = entry.lastUsed;
      lruKey = key;
    }
  }
  if (lruKey) {
    try { cache.get(lruKey)?.storage.close(); } catch { /* ignore */ }
    cache.delete(lruKey);
  }
}

/**
 * Return a cached Storage for the given absolute DB path.
 * Creates a new Storage if not in cache; evicts idle/LRU entries as needed.
 */
export function getStorage(absDbPath: string): Storage {
  evictIdle();
  const entry = cache.get(absDbPath);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.storage;
  }
  evictLru();
  const storage = new Storage(absDbPath);
  cache.set(absDbPath, { storage, lastUsed: Date.now() });
  return storage;
}

/**
 * Resolve the DB path from a project hint (or env/cwd fallback) and return a
 * cached Storage. Resolution priority:
 *   1. projectHint — registry lookup (name / partial path), then direct path
 *   2. NCA_DB_PATH env var
 *   3. <cwd>/.nca/nca.db autodetect
 */
export function resolveAndGetStorage(projectHint?: string): Storage {
  if (projectHint) {
    const found = findProject(projectHint);
    if (found) {
      if (!found.dbExists) {
        throw new Error(`No NCA index found at ${found.root}. Run: nca scan ${found.root}`);
      }
      return getStorage(path.resolve(found.dbPath));
    }
    const abs = path.resolve(projectHint);
    const dbPath = path.join(abs, '.nca', 'nca.db');
    if (!fs.existsSync(dbPath)) {
      throw new Error(`No NCA index found at ${abs}. Run: nca scan ${abs}`);
    }
    return getStorage(dbPath);
  }

  if (process.env.NCA_DB_PATH) {
    const dbPath = path.resolve(process.env.NCA_DB_PATH);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`No NCA index found at ${dbPath}. Run: nca scan <project-root>`);
    }
    return getStorage(dbPath);
  }

  const cwd = process.cwd();
  const dbPath = path.join(cwd, '.nca', 'nca.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No NCA index found at ${cwd}. Run: nca scan ${cwd}`);
  }
  return getStorage(dbPath);
}

/**
 * Derive the project root from a resolved DB path.
 * Assumes standard layout: <root>/.nca/nca.db. Falls back to the DB's parent.
 */
export function rootFromDbPath(dbPath: string): string {
  const parent = path.dirname(path.resolve(dbPath));
  return path.basename(parent) === '.nca' ? path.dirname(parent) : parent;
}

export function closeAll(): void {
  for (const [, entry] of cache) {
    try { entry.storage.close(); } catch { /* ignore */ }
  }
  cache.clear();
}

// Exported for deterministic testing only.
export function getCacheSize(): number { return cache.size; }
export function forceSetLastUsed(absDbPath: string, timeMs: number): void {
  const entry = cache.get(absDbPath);
  if (entry) entry.lastUsed = timeMs;
}

const idleTimer = setInterval(evictIdle, 30_000);
(idleTimer as NodeJS.Timeout).unref?.();

process.on('exit', closeAll);
process.on('SIGINT', () => { closeAll(); process.exit(0); });
