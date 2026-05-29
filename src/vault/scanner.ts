import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedNote } from './parser.js';

export interface ScanResult {
  indexed: number;
  updated: number;
  unchanged: number;
  errors: number;
}

export class VaultScanner {
  constructor(private db: Database.Database) {}

  async scan(
    root: string,
    opts?: {
      dryRun?: boolean;
      verbose?: boolean;
      quiet?: boolean;
      excludedDirNames?: Set<string>;
    }
  ): Promise<ScanResult> {
    const result: ScanResult = { indexed: 0, updated: 0, unchanged: 0, errors: 0 };
    const startTime = Date.now();

    const defaultExclusions = ['.obsidian/', '.trash/', '.smart-connections/', 'node_modules/', '.git/'];

    let ignorePatterns: string[] = [];
    if (!opts?.excludedDirNames) {
      const claudeignorePath = path.join(root, '.claudeignore');
      if (fs.existsSync(claudeignorePath)) {
        const content = fs.readFileSync(claudeignorePath, 'utf-8');
        ignorePatterns = content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'));
      }
    }

    // Lazy-load minimatch only in vault mode when .claudeignore patterns exist
    let minimatchFn: ((p: string, pattern: string, opts?: object) => boolean) | undefined;
    if (!opts?.excludedDirNames && ignorePatterns.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      minimatchFn = (require('minimatch') as { minimatch: (p: string, pattern: string, opts?: object) => boolean }).minimatch;
    }

    const mdFiles: string[] = [];

    const walkDir = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (opts?.excludedDirNames) {
          // Project mode: exclude by directory name, same strategy as code scanner
          if (entry.isDirectory()) {
            if (!opts.excludedDirNames.has(entry.name) && !entry.name.startsWith('.')) {
              walkDir(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            mdFiles.push(fullPath);
          }
        } else {
          // Vault mode: existing path-substring exclusion + .claudeignore
          const relativePath = path.relative(root, fullPath);
          let shouldSkip = false;
          for (const exc of defaultExclusions) {
            if (relativePath.includes(exc)) { shouldSkip = true; break; }
          }
          if (!shouldSkip && minimatchFn) {
            for (const pattern of ignorePatterns) {
              if (minimatchFn(relativePath, pattern, { matchBase: true })) { shouldSkip = true; break; }
            }
          }
          if (shouldSkip) continue;
          if (entry.isDirectory()) { walkDir(fullPath); }
          else if (entry.isFile() && entry.name.endsWith('.md')) { mdFiles.push(fullPath); }
        }
      }
    };

    walkDir(root);

    // Lazy-load parseNote only when there are actual .md files to parse
    const parsedNotes: (ParsedNote | null)[] = [];
    if (mdFiles.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { parseNote } = require('./parser.js') as typeof import('./parser.js');
      for (const filePath of mdFiles) {
        try {
          const note = await parseNote(filePath);
          parsedNotes.push(note);
        } catch (err) {
          result.errors++;
          process.stderr.write(`Error parsing ${filePath}: ${(err as Error).message}\n`);
          parsedNotes.push(null);
        }
      }
    }

    const tx = this.db.transaction(() => {
      for (let i = 0; i < mdFiles.length; i++) {
        const note = parsedNotes[i];
        if (!note) continue;
        const outcome = this.upsertNoteRecord(note);
        result[outcome]++;
        if (opts?.verbose) {
          process.stdout.write(`  ${path.relative(root, mdFiles[i])}\n`);
        }
      }
    });

    if (!opts?.dryRun) {
      tx();
    }

    if (!opts?.quiet) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`[OK] Vault scan completed in ${duration}s\n`);
      process.stdout.write(`- Indexed:   ${result.indexed}\n`);
      process.stdout.write(`- Updated:   ${result.updated}\n`);
      process.stdout.write(`- Unchanged: ${result.unchanged}\n`);
      process.stdout.write(`- Errors:    ${result.errors}\n`);
    }

    return result;
  }

  async scanMdFile(filePath: string): Promise<'indexed' | 'updated' | 'unchanged' | 'error'> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseNote } = require('./parser.js') as typeof import('./parser.js');
    let note: ParsedNote;
    try {
      note = await parseNote(filePath);
    } catch (err) {
      process.stderr.write(`Error parsing ${filePath}: ${(err as Error).message}\n`);
      return 'error';
    }

    let outcome: 'indexed' | 'updated' | 'unchanged' = 'unchanged';
    const tx = this.db.transaction(() => {
      outcome = this.upsertNoteRecord(note);
    });
    tx();
    return outcome;
  }

  deleteMdFile(filePath: string): void {
    const normalizedPath = filePath.replace(/\\/g, '/');
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(normalizedPath);
  }

  private upsertNoteRecord(note: ParsedNote): 'indexed' | 'updated' | 'unchanged' {
    const existing = this.db
      .prepare('SELECT id, content_hash FROM notes WHERE path = ?')
      .get(note.path) as { id: string; content_hash: string } | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO notes (id, path, type, status, area, summary, updated, content_hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
          note.id,
          note.path,
          note.type ?? null,
          note.status,
          note.area ?? null,
          note.summary ?? null,
          note.updated ?? null,
          note.contentHash
        );
      for (let j = 0; j < note.bodyChunks.length; j++) {
        this.db
          .prepare(`INSERT INTO note_chunks (note_id, chunk_idx, text) VALUES (?, ?, ?)`)
          .run(note.id, j, note.bodyChunks[j]);
      }
      return 'indexed';
    }

    if (existing.content_hash !== note.contentHash) {
      this.db.prepare('DELETE FROM note_chunks WHERE note_id = ?').run(existing.id);
      for (let j = 0; j < note.bodyChunks.length; j++) {
        this.db
          .prepare(`INSERT INTO note_chunks (note_id, chunk_idx, text) VALUES (?, ?, ?)`)
          .run(existing.id, j, note.bodyChunks[j]);
      }
      this.db
        .prepare(
          `UPDATE notes SET type = ?, status = ?, area = ?, summary = ?, updated = ?, content_hash = ?, indexed_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          note.type ?? null,
          note.status,
          note.area ?? null,
          note.summary ?? null,
          note.updated ?? null,
          note.contentHash,
          existing.id
        );
      return 'updated';
    }

    return 'unchanged';
  }
}
