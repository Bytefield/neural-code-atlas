import type BetterSqlite3 from 'better-sqlite3';

export interface VaultSearchResult {
  id: string;
  path: string;
  type: string | null;
  area: string | null;
  status: string;
  updated: string | null;
  summary: string | null;
  snippet: string;
}

export interface VaultSearchFilters {
  area?: string;
  type?: string;
  status?: string;
}

export function vaultSearch(
  db: BetterSqlite3.Database,
  query: string,
  filters: VaultSearchFilters = {},
  limit = 10
): VaultSearchResult[] {
  const terms = query
    .split(/\s+/)
    .map(t => t.replace(/['"*]/g, '').trim())
    .filter(Boolean)
    .map(t => `${t}*`);

  if (terms.length === 0) return [];

  const ftsQuery = terms.join(' ');
  const conditions: string[] = [];
  const filterParams: unknown[] = [];

  if (filters.area) { conditions.push('n.area = ?'); filterParams.push(filters.area); }
  if (filters.type) { conditions.push('n.type = ?'); filterParams.push(filters.type); }
  if (filters.status) { conditions.push('n.status = ?'); filterParams.push(filters.status); }

  const whereClause = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
  const safeLimit = Math.min(Math.max(1, limit), 50);

  // Over-fetch to ensure dedup yields enough unique notes.
  // FTS5 can return multiple chunks per note; dedup in JS keeps best-ranked snippet.
  const fetchLimit = safeLimit * 4;

  try {
    const rows = db.prepare(`
      SELECT n.id, n.path, n.type, n.area, n.status, n.updated, n.summary,
        snippet(note_chunks_fts, 0, '', '', '...', 20) AS snippet
      FROM note_chunks_fts fts
      JOIN note_chunks nc ON nc.rowid = fts.rowid
      JOIN notes n ON n.id = nc.note_id
      WHERE note_chunks_fts MATCH ?${whereClause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(ftsQuery, ...filterParams, fetchLimit) as any[];

    const seen = new Set<string>();
    const results: VaultSearchResult[] = [];

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      results.push({
        id: r.id,
        path: r.path,
        type: r.type ?? null,
        area: r.area ?? null,
        status: r.status,
        updated: r.updated ?? null,
        summary: r.summary ?? null,
        snippet: r.snippet ?? '',
      });
      if (results.length >= safeLimit) break;
    }

    return results;
  } catch {
    return [];
  }
}
