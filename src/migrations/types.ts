import type { Database } from 'better-sqlite3';

/**
 * Result returned by a migration's up() function.
 * Used to record what happened in migration_log.
 */
export interface MigrationResult {
  /** Optional structured info about what the migration did (rows affected, etc.). */
  info?: Record<string, unknown>;
}

/**
 * A single, ordered, idempotent schema migration.
 * Migrations run inside a transaction. Throwing aborts and rolls back.
 */
export interface Migration {
  /** Monotonically increasing integer. 1, 2, 3... No gaps allowed. */
  version: number;
  /** Short snake_case identifier. Used in migration_log. */
  name: string;
  /** Apply this migration. Must be deterministic. Throw on failure. */
  up(db: Database): MigrationResult;
}
