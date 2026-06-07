import type { Database } from 'better-sqlite3';
import type { Migration } from './types.js';
import { migration001 } from './001_init_schema.js';
import { migration002 } from './002_repair_line_move_duplicates.js';
import { migration003 } from './003_vault_schema.js';
import { migration004 } from './004_doc_code_edges.js';

/**
 * All migrations in order. Future migrations append here.
 * Versions MUST be contiguous starting from 1.
 */
const ALL_MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
];

/**
 * Custom error class so callers can distinguish migration failures from
 * other errors and report them clearly.
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly version: number,
    public readonly migrationName: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Read the current schema_version from the DB.
 * Returns 0 if schema_meta does not exist yet (fresh DB or pre-migrations DB).
 */
function readCurrentVersion(db: Database): number {
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'
  `).get() as { name: string } | undefined;

  if (!tableExists) return 0;

  const row = db.prepare(`
    SELECT value FROM schema_meta WHERE key = 'schema_version'
  `).get() as { value: string } | undefined;

  if (!row) return 0;
  const parsed = parseInt(row.value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new MigrationError(
      `Invalid schema_version in DB: '${row.value}'`,
      0,
      'readCurrentVersion'
    );
  }
  return parsed;
}

/**
 * Run every pending migration in order. Each migration runs in its own transaction.
 * On failure: rollback that migration, throw MigrationError, do NOT touch later migrations.
 * The DB is left at the version of the last successfully applied migration.
 */
export function runMigrations(db: Database): { applied: number[]; from: number; to: number } {
  const startVersion = readCurrentVersion(db);
  const targetVersion = ALL_MIGRATIONS.length > 0
    ? Math.max(...ALL_MIGRATIONS.map(m => m.version))
    : 0;

  if (startVersion > targetVersion) {
    throw new MigrationError(
      `DB schema_version (${startVersion}) is newer than this build supports (${targetVersion}). ` +
      `Upgrade NCA or restore a compatible DB.`,
      startVersion,
      'runMigrations'
    );
  }

  // Validate that ALL_MIGRATIONS is contiguous from 1.
  for (let i = 0; i < ALL_MIGRATIONS.length; i++) {
    const expected = i + 1;
    if (ALL_MIGRATIONS[i].version !== expected) {
      throw new MigrationError(
        `Migration list is non-contiguous: expected version ${expected}, got ${ALL_MIGRATIONS[i].version}`,
        ALL_MIGRATIONS[i].version,
        ALL_MIGRATIONS[i].name
      );
    }
  }

  const pending = ALL_MIGRATIONS.filter(m => m.version > startVersion);
  const applied: number[] = [];

  for (const migration of pending) {
    const tx = db.transaction(() => {
      const result = migration.up(db);

      db.prepare(`
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(migration.version));

      db.prepare(`
        INSERT INTO migration_log (version, name, applied_at, result)
        VALUES (?, ?, unixepoch(), ?)
      `).run(
        migration.version,
        migration.name,
        JSON.stringify(result.info ?? {})
      );
    });

    try {
      tx();
      applied.push(migration.version);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed: ${cause.message}`,
        migration.version,
        migration.name,
        cause
      );
    }
  }

  return { applied, from: startVersion, to: targetVersion };
}

/**
 * Returns migration status without applying anything. Used by `nca migrate --status`.
 */
export function getMigrationStatus(db: Database): {
  currentVersion: number;
  targetVersion: number;
  pending: { version: number; name: string }[];
} {
  const currentVersion = readCurrentVersion(db);
  const targetVersion = ALL_MIGRATIONS.length > 0
    ? Math.max(...ALL_MIGRATIONS.map(m => m.version))
    : 0;
  const pending = ALL_MIGRATIONS
    .filter(m => m.version > currentVersion)
    .map(m => ({ version: m.version, name: m.name }));
  return { currentVersion, targetVersion, pending };
}
