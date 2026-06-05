import * as fs from 'fs';
import type BetterSqlite3 from 'better-sqlite3';

export interface VaultNoteDetail {
  id: string;
  path: string;
  type: string | null;
  area: string | null;
  status: string;
  updated: string | null;
  summary: string | null;
  indexed_at: string;
  body?: string;
}

export function vaultGet(
  db: BetterSqlite3.Database,
  idOrPath: string,
  includeBody = false
): VaultNoteDetail | null {
  const normalized = idOrPath.replace(/\\/g, '/');

  // Resolution order: exact id → exact path → suffix path match → stem match
  const row: any =
    db.prepare('SELECT * FROM notes WHERE id = ?').get(normalized) ??
    db.prepare('SELECT * FROM notes WHERE path = ?').get(normalized) ??
    db.prepare("SELECT * FROM notes WHERE path LIKE ? ESCAPE '\\'").get(`%/${normalized}`) ??
    db.prepare("SELECT * FROM notes WHERE path LIKE ? ESCAPE '\\'").get(`%/${normalized}.md`);

  if (!row) return null;

  const detail: VaultNoteDetail = {
    id: row.id,
    path: row.path,
    type: row.type ?? null,
    area: row.area ?? null,
    status: row.status,
    updated: row.updated ?? null,
    summary: row.summary ?? null,
    indexed_at: row.indexed_at,
  };

  if (includeBody) {
    try {
      detail.body = fs.readFileSync(row.path, 'utf-8');
    } catch {
      detail.body = '';
    }
  }

  return detail;
}
