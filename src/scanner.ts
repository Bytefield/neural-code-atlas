import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Storage } from './storage.js';
import { NCAParser } from './parser.js';

const DEFAULT_EXCLUDED_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'coverage', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.nca', 'vendor', '.venv', 'venv', 'env',
];

const DEFAULT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

export interface ScannerConfig {
  exclude?: string[];
  include_extensions?: string[];
  max_file_size_kb?: number;
}

function loadConfig(rootPath: string): ScannerConfig {
  const configPath = path.join(rootPath, '.nca', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ScannerConfig;
  } catch {
    return {};
  }
}

export interface ScanResult {
  scanned: number;
  skipped: number;
  parsed: number;
  errors: number;
  durationMs: number;
}

export class Scanner {
  private storage: Storage;
  private parser: NCAParser;

  constructor(storage: Storage) {
    this.storage = storage;
    this.parser = new NCAParser();
  }

  scan(rootPath: string): ScanResult {
    const start = Date.now();
    const result: ScanResult = { scanned: 0, skipped: 0, parsed: 0, errors: 0, durationMs: 0 };

    const config = loadConfig(rootPath);
    const files = this.collectFiles(rootPath, config);
    result.scanned = files.length;

    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        const mtime = Math.floor(stat.mtimeMs);
        const record = this.storage.getFileRecord(filePath);

        // Check if file changed
        if (record && record.mtime === mtime) {
          result.skipped++;
          continue;
        }

        const sha256 = hashFile(filePath);

        if (record && record.sha256 === sha256) {
          // mtime changed but content same — update mtime only
          this.storage.upsertFileRecord(filePath, mtime, sha256);
          result.skipped++;
          continue;
        }

        // File is new or changed — per-node diff to avoid full FTS churn
        const oldChecksums = this.storage.getCellChecksums(filePath);
        const nodes = this.parser.parseFile(filePath, sha256, rootPath);
        const currentNames = new Set(nodes.map(n => n.name));

        const changed = nodes.filter(n => oldChecksums.get(n.name) !== n.sha256);
        if (changed.length > 0) {
          this.storage.upsertNodes(changed);
        }
        this.storage.deleteRemovedCells(filePath, currentNames);
        this.storage.upsertFileRecord(filePath, mtime, sha256);
        result.parsed++;
      } catch (err) {
        result.errors++;
        process.stderr.write(`NCA|parse_error|${filePath}|${(err as Error).message}\n`);
      }
    }

    result.durationMs = Date.now() - start;
    return result;
  }

  /**
   * Process a single file — used by the watch command to avoid full directory walks.
   */
  scanFile(filePath: string, rootPath: string): ScanResult {
    const start = Date.now();
    const result: ScanResult = { scanned: 1, skipped: 0, parsed: 0, errors: 0, durationMs: 0 };

    // Validate extension — same gate as collectFiles
    const ext = path.extname(filePath).toLowerCase();
    if (!DEFAULT_EXTS.includes(ext)) {
      result.skipped++;
      result.durationMs = Date.now() - start;
      return result;
    }

    try {
      const stat = fs.statSync(filePath);

      // Validate size — same gate as collectFiles
      const config = loadConfig(rootPath);
      const maxSizeBytes = (config.max_file_size_kb ?? 512) * 1024;
      if (stat.size > maxSizeBytes) {
        process.stderr.write(`NCA|skip_large|${filePath}|${stat.size}\n`);
        result.skipped++;
        result.durationMs = Date.now() - start;
        return result;
      }

      const mtime = Math.floor(stat.mtimeMs);
      const record = this.storage.getFileRecord(filePath);

      if (record && record.mtime === mtime) {
        result.skipped++;
        result.durationMs = Date.now() - start;
        return result;
      }

      const sha256 = hashFile(filePath);

      if (record && record.sha256 === sha256) {
        this.storage.upsertFileRecord(filePath, mtime, sha256);
        result.skipped++;
        result.durationMs = Date.now() - start;
        return result;
      }

      const oldChecksums = this.storage.getCellChecksums(filePath);
      const nodes = this.parser.parseFile(filePath, sha256, rootPath);
      const currentNames = new Set(nodes.map(n => n.name));

      const changed = nodes.filter(n => oldChecksums.get(n.name) !== n.sha256);
      if (changed.length > 0) {
        this.storage.upsertNodes(changed);
      }
      this.storage.deleteRemovedCells(filePath, currentNames);
      this.storage.upsertFileRecord(filePath, mtime, sha256);
      result.parsed++;
    } catch (err) {
      result.errors++;
      process.stderr.write(`NCA|parse_error|${filePath}|${(err as Error).message}\n`);
    }

    result.durationMs = Date.now() - start;
    return result;
  }

  private collectFiles(dir: string, config: ScannerConfig): string[] {
    const excludedDirs = new Set([
      ...DEFAULT_EXCLUDED_DIRS,
      ...(config.exclude ?? []),
    ]);
    const supportedExts = new Set(
      config.include_extensions
        ? config.include_extensions.map(e => (e.startsWith('.') ? e : `.${e}`))
        : DEFAULT_EXTS
    );
    const maxSizeBytes = (config.max_file_size_kb ?? 512) * 1024;

    const files: string[] = [];
    const stack: string[] = [dir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!excludedDirs.has(entry.name) && !entry.name.startsWith('.')) {
            stack.push(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!supportedExts.has(ext)) continue;
          try {
            const size = fs.statSync(fullPath).size;
            if (size > maxSizeBytes) {
              process.stderr.write(`NCA|skip_large|${fullPath}|${size}\n`);
              continue;
            }
          } catch { continue; }
          files.push(fullPath);
        }
      }
    }

    return files;
  }
}

function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}
