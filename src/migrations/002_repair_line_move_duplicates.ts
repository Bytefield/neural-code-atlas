import type { Database } from 'better-sqlite3';
import type { Migration, MigrationResult } from './types.js';

/**
 * Migration 002 — Repair line-move duplicates.
 *
 * Pre-fix scanners left stale duplicates whenever a function moved within a
 * file (e.g. inserting a blank line above it). Both the old (name, file, oldLine)
 * row and the new (name, file, newLine) row would coexist because
 * deleteRemovedCells filtered only by name.
 *
 * This migration scans for groups (name, file) with > 1 row and keeps the row
 * with the most recent file_index.parsed_at (or highest id as tiebreaker),
 * deleting the rest.
 *
 * Ambiguous groups (multiple rows with the same `line` value but different
 * `sha256`) are NOT touched. They should not exist (UNIQUE(name, file, line))
 * but we log them in result.info for forensic analysis.
 */
export const migration002: Migration = {
  version: 2,
  name: 'repair_line_move_duplicates',
  up(db: Database): MigrationResult {
    const groups = db.prepare(`
      SELECT name, file, COUNT(*) AS cnt
      FROM nodes
      GROUP BY name, file
      HAVING cnt > 1
    `).all() as { name: string; file: string; cnt: number }[];

    let groupsRepaired = 0;
    let rowsRemoved = 0;
    const ambiguousGroups: { name: string; file: string; lines: number[] }[] = [];

    const selectGroup = db.prepare(`
      SELECT n.id, n.line, n.sha256, fi.parsed_at AS parsed_at
      FROM nodes n
      LEFT JOIN file_index fi ON fi.path = n.file
      WHERE n.name = ? AND n.file = ?
      ORDER BY COALESCE(fi.parsed_at, 0) DESC, n.id DESC
    `);

    const deleteById = db.prepare(`DELETE FROM nodes WHERE id = ?`);

    for (const group of groups) {
      const rows = selectGroup.all(group.name, group.file) as {
        id: number;
        line: number;
        sha256: string;
        parsed_at: number | null;
      }[];

      // Detect ambiguity: multiple rows sharing the same line value
      const linesSeen = new Map<number, number>();
      for (const r of rows) linesSeen.set(r.line, (linesSeen.get(r.line) ?? 0) + 1);
      const hasAmbiguity = [...linesSeen.values()].some(c => c > 1);

      if (hasAmbiguity) {
        ambiguousGroups.push({
          name: group.name,
          file: group.file,
          lines: rows.map(r => r.line),
        });
        continue;
      }

      // Keep first (most recent), delete the rest
      for (let i = 1; i < rows.length; i++) {
        deleteById.run(rows[i].id);
        rowsRemoved++;
      }
      groupsRepaired++;
    }

    return {
      info: {
        groups_repaired: groupsRepaired,
        rows_removed: rowsRemoved,
        ambiguous_groups: ambiguousGroups,
      },
    };
  },
};
