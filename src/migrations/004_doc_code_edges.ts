import type { Database } from 'better-sqlite3';
import type { Migration, MigrationResult } from './types.js';

/**
 * Migration 004 — doc_code_edges schema.
 *
 * Adds a cross-reference table linking vault notes to code graph nodes.
 * Populated by VaultScanner when a note's frontmatter contains
 * `references.symbols` (an array of code symbol names).
 *
 *   - doc_code_edges : one row per (note, symbol) pair
 *     - node_id is the composite key "file:name" if the symbol was found in
 *       the code graph; NULL if the symbol exists in frontmatter but not in
 *       the graph yet (broken edge, tracked for audit purposes)
 *
 * Uses IF NOT EXISTS throughout (consistent with prior migrations) so the
 * migration is safe in manual rollback/replay scenarios.
 */
export const migration004: Migration = {
  version: 4,
  name: 'doc_code_edges',
  up(db: Database): MigrationResult {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_code_edges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id     TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        node_id     TEXT,
        edge_type   TEXT NOT NULL DEFAULT 'references',
        created_at  TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
        UNIQUE(note_id, symbol_name)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_code_edges_note   ON doc_code_edges(note_id);
      CREATE INDEX IF NOT EXISTS idx_doc_code_edges_symbol ON doc_code_edges(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_doc_code_edges_node   ON doc_code_edges(node_id);
    `);

    return {
      info: {
        tables_ensured: ['doc_code_edges'],
        indexes_ensured: [
          'idx_doc_code_edges_note',
          'idx_doc_code_edges_symbol',
          'idx_doc_code_edges_node',
        ],
      },
    };
  },
};
