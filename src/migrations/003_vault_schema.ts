import type { Database } from 'better-sqlite3';
import type { Migration, MigrationResult } from './types.js';

/**
 * Migration 003 — Vault schema.
 *
 * Adds tables for indexing Obsidian Markdown vaults alongside the existing
 * code index. New tables are prefixed with `notes` / `note_chunks` to avoid
 * any collision with the existing code schema.
 *
 *   - notes           : one row per .md file (frontmatter fields + hash)
 *   - note_chunks     : body chunks for FTS, linked by note_id
 *   - note_chunks_fts : FTS5 virtual table with unicode61 tokenizer
 *   - Three sync triggers keep the FTS index in sync with note_chunks
 *   - Indexes on notes.status, notes.area, notes.type for filtered queries
 *
 * Uses IF NOT EXISTS throughout (consistent with migration001) so the migration
 * is safe in manual rollback/replay scenarios without touching existing data.
 */
export const migration003: Migration = {
  version: 3,
  name: 'vault_schema',
  up(db: Database): MigrationResult {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id           TEXT PRIMARY KEY,
        path         TEXT NOT NULL UNIQUE,
        type         TEXT,
        status       TEXT NOT NULL DEFAULT 'vigente',
        area         TEXT,
        summary      TEXT,
        updated      TEXT,
        content_hash TEXT NOT NULL,
        indexed_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS note_chunks (
        note_id   TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        chunk_idx INTEGER NOT NULL,
        text      TEXT    NOT NULL,
        PRIMARY KEY (note_id, chunk_idx)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS note_chunks_fts USING fts5(
        text,
        content='note_chunks',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS note_chunks_ai AFTER INSERT ON note_chunks BEGIN
        INSERT INTO note_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS note_chunks_ad AFTER DELETE ON note_chunks BEGIN
        INSERT INTO note_chunks_fts(note_chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS note_chunks_au AFTER UPDATE ON note_chunks BEGIN
        INSERT INTO note_chunks_fts(note_chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO note_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
      CREATE INDEX IF NOT EXISTS idx_notes_area   ON notes(area);
      CREATE INDEX IF NOT EXISTS idx_notes_type   ON notes(type);
    `);

    return {
      info: {
        tables_ensured: ['notes', 'note_chunks'],
        virtual_tables_ensured: ['note_chunks_fts'],
        triggers_ensured: ['note_chunks_ai', 'note_chunks_ad', 'note_chunks_au'],
        indexes_ensured: ['idx_notes_status', 'idx_notes_area', 'idx_notes_type'],
      },
    };
  },
};
