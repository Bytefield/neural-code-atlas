import type { Database } from 'better-sqlite3';
import type { Migration, MigrationResult } from './types.js';

/**
 * Migration 001 — Initial schema.
 *
 * Creates the full set of tables that NCA needs:
 *   - schema_meta, migration_log (migration tracking)
 *   - file_index, nodes, nodes_fts (core data)
 *   - flows, warnings, query_log, node_scores (auxiliary)
 *   - Three FTS sync triggers and two indexes on nodes
 *
 * Idempotent on legacy DBs: uses CREATE TABLE IF NOT EXISTS and
 * CREATE TRIGGER IF NOT EXISTS throughout, so existing data is preserved.
 *
 * PRAGMAs (journal_mode, foreign_keys, synchronous) are set by the Storage
 * constructor before migrations run and are therefore absent here.
 */
export const migration001: Migration = {
  version: 1,
  name: 'init_schema',
  up(db: Database): MigrationResult {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS migration_log (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at INTEGER NOT NULL,
        result     TEXT
      );

      CREATE TABLE IF NOT EXISTS file_index (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT    UNIQUE NOT NULL,
        mtime      INTEGER NOT NULL,
        sha256     TEXT    NOT NULL,
        parsed_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT    NOT NULL,
        name       TEXT    NOT NULL,
        module     TEXT    NOT NULL DEFAULT '',
        inputs     TEXT    NOT NULL DEFAULT '[]',
        outputs    TEXT    NOT NULL DEFAULT '[]',
        deps       TEXT    NOT NULL DEFAULT '[]',
        effects    TEXT    NOT NULL DEFAULT '[]',
        complexity INTEGER NOT NULL DEFAULT 1,
        file       TEXT    NOT NULL,
        line       INTEGER NOT NULL DEFAULT 0,
        sha256     TEXT    NOT NULL DEFAULT '',
        UNIQUE(name, file, line)
      );

      CREATE TABLE IF NOT EXISTS flows (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    UNIQUE NOT NULL,
        steps      TEXT    NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS warnings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id    TEXT    NOT NULL,
        node_id    TEXT    NOT NULL,
        detail     TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        name, module, inputs, outputs, deps, effects, file,
        content='nodes', content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, name, module, inputs, outputs, deps, effects, file)
        VALUES (new.id, new.name, new.module, new.inputs, new.outputs, new.deps, new.effects, new.file);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, name, module, inputs, outputs, deps, effects, file)
        VALUES ('delete', old.id, old.name, old.module, old.inputs, old.outputs, old.deps, old.effects, old.file);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, name, module, inputs, outputs, deps, effects, file)
        VALUES ('delete', old.id, old.name, old.module, old.inputs, old.outputs, old.deps, old.effects, old.file);
        INSERT INTO nodes_fts(rowid, name, module, inputs, outputs, deps, effects, file)
        VALUES (new.id, new.name, new.module, new.inputs, new.outputs, new.deps, new.effects, new.file);
      END;

      CREATE INDEX IF NOT EXISTS idx_nodes_file_name ON nodes(file, name);
      CREATE INDEX IF NOT EXISTS idx_nodes_module    ON nodes(module);

      CREATE TABLE IF NOT EXISTS query_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        query       TEXT    NOT NULL,
        matched_ids TEXT,
        ts          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_scores (
        cell_id      TEXT    PRIMARY KEY,
        query_count  INTEGER DEFAULT 0,
        last_queried INTEGER,
        score_boost  REAL    DEFAULT 0.0
      );
    `);

    db.exec(`
      INSERT INTO schema_meta (key, value) VALUES ('nca_version', '1.0.0')
      ON CONFLICT(key) DO NOTHING;
    `);

    return {
      info: {
        tables_ensured: [
          'schema_meta', 'migration_log', 'file_index', 'nodes', 'nodes_fts',
          'flows', 'warnings', 'query_log', 'node_scores',
        ],
        triggers_ensured: ['nodes_ai', 'nodes_ad', 'nodes_au'],
        indexes_ensured: ['idx_nodes_file_name', 'idx_nodes_module'],
        nca_version_recorded: '1.0.0',
      },
    };
  },
};
