import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { parseNote, type ParsedNote } from './parser.js';

export interface ScanResult {
  indexed: number;
  updated: number;
  unchanged: number;
  errors: number;
}

export class VaultScanner {
  constructor(private db: Database.Database) {}

  async scan(root: string, opts?: { dryRun?: boolean; verbose?: boolean }): Promise<ScanResult> {
    const result: ScanResult = { indexed: 0, updated: 0, unchanged: 0, errors: 0 };
    const startTime = Date.now();

    // Default exclusions
    const defaultExclusions = ['.obsidian/', '.trash/', '.smart-connections/', 'node_modules/', '.git/'];

    // Load .claudeignore patterns if it exists
    const claudeignorePath = path.join(root, '.claudeignore');
    let ignorePatterns: string[] = [];
    if (fs.existsSync(claudeignorePath)) {
      const content = fs.readFileSync(claudeignorePath, 'utf-8');
      ignorePatterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
    }

    // Walk directory recursively to find all .md files
    const mdFiles: string[] = [];
    const walkDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath);

        // Check if path contains any default exclusions
        let shouldSkip = false;
        for (const exc of defaultExclusions) {
          if (relativePath.includes(exc)) {
            shouldSkip = true;
            break;
          }
        }

        // Check against .claudeignore patterns
        if (!shouldSkip && ignorePatterns.length > 0) {
          for (const pattern of ignorePatterns) {
            if (minimatch(relativePath, pattern, { matchBase: true })) {
              shouldSkip = true;
              break;
            }
          }
        }

        if (shouldSkip) continue;

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          mdFiles.push(fullPath);
        }
      }
    };

    walkDir(root);

    // Parse all notes first (async), then batch into transaction
    const parsedNotes: (ParsedNote | null)[] = [];
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

    // Use transaction to batch all database operations
    const tx = this.db.transaction(() => {
      for (let i = 0; i < mdFiles.length; i++) {
        const filePath = mdFiles[i];
        const note = parsedNotes[i];

        if (!note) continue;

        // Look up existing note by path
        const existing = this.db
          .prepare('SELECT id, content_hash FROM notes WHERE path = ?')
          .get(note.path) as any;

        if (!existing) {
          // INSERT new note
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

          // INSERT chunks
          for (let j = 0; j < note.bodyChunks.length; j++) {
            this.db
              .prepare(`INSERT INTO note_chunks (note_id, chunk_idx, text) VALUES (?, ?, ?)`)
              .run(note.id, j, note.bodyChunks[j]);
          }

          result.indexed++;
        } else if (existing.content_hash !== note.contentHash) {
          // UPDATE: hash differs
          // Delete old chunks
          this.db.prepare('DELETE FROM note_chunks WHERE note_id = ?').run(existing.id);

          // Insert new chunks
          for (let j = 0; j < note.bodyChunks.length; j++) {
            this.db
              .prepare(`INSERT INTO note_chunks (note_id, chunk_idx, text) VALUES (?, ?, ?)`)
              .run(existing.id, j, note.bodyChunks[j]);
          }

          // Update note record
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

          result.updated++;
        } else {
          // No change
          result.unchanged++;
        }

        if (opts?.verbose) {
          process.stdout.write(`  ${path.relative(root, filePath)}\n`);
        }
      }
    });

    // Only execute transaction if NOT dryRun
    if (!opts?.dryRun) {
      tx();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`[OK] Vault scan completed in ${duration}s\n`);
    process.stdout.write(`- Indexed:   ${result.indexed}\n`);
    process.stdout.write(`- Updated:   ${result.updated}\n`);
    process.stdout.write(`- Unchanged: ${result.unchanged}\n`);
    process.stdout.write(`- Errors:    ${result.errors}\n`);

    return result;
  }
}
