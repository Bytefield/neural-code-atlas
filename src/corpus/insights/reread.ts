import { OrientationEvent } from '../types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOP_N_EXCLUDED = 5;
const DEFAULT_VAULT_MARKER = 'obsidian_vault';

export interface RereadOptions {
  vaultMarker?: string;    // case-insensitive substring identifying vault paths; default 'obsidian_vault'
  topNExcluded?: number;   // exclude the N most-frequently-read files (a small static cache already covers them); default 5
}

export interface RereadResult {
  value: number | null;    // reread_count / denominator, or null if denominator is 0
  numerator: number;
  denominator: number;
  excludedVaultReads: number;
  excludedTopNReads: number;
  excludedTopNFiles: string[];
  sampleEvidence: string[]; // "file:<path>" pointers, top few re-read files by count
}

/**
 * REREAD_MEMORY_V1 — reproduces the P4a exploratory methodology (SIN-VAULT-SIN-TOP5,
 * 7-day window): among Read tool calls (the only tool with a reliable file_path
 * signal in this schema — see EXPLORATORY-ANALYSIS-P4A-BRIEF-INJECTION-2026-08-20),
 * excluding vault paths and the top-N most-frequently-read files (already covered by
 * a small static cache regardless of full session memory), what fraction of the
 * remaining reads are a re-read of a file already read in a DIFFERENT, earlier
 * session (cross-session — P4a's whole premise is persisting across sessions, so
 * two reads of the same file within the SAME session are not "avoidable reread":
 * the content is already in that session's context) within the preceding 7 days
 * of the nearest such prior cross-session read?
 *
 * Verified against the real frozen synio baseline (~/.nca/metrics/synio/, read-only):
 * this cross-session definition reproduces the doc's PASADA 1 raw figures almost
 * exactly (267/877 vs documented 266/877 global; 208/877 vs documented 208/877 at
 * the 7-day window, exact) — a same-session-inclusive definition does not (it
 * overcounts by roughly 60%), which is what led to this definition.
 */
export function computeRereadRate(events: OrientationEvent[], opts: RereadOptions = {}): RereadResult {
  const vaultMarker = (opts.vaultMarker ?? DEFAULT_VAULT_MARKER).toLowerCase();
  const topN = opts.topNExcluded ?? DEFAULT_TOP_N_EXCLUDED;

  const reads = events
    .filter(e => e.event_type === 'post_tool_use' && e.tool_name === 'Read' && typeof e.file_path === 'string')
    .map(e => ({ file_path: e.file_path as string, timestamp: e.timestamp, source_session_id: e.source_session_id }))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  const vaultReads = reads.filter(r => r.file_path.toLowerCase().includes(vaultMarker));
  const nonVaultReads = reads.filter(r => !r.file_path.toLowerCase().includes(vaultMarker));

  const countByFile = new Map<string, number>();
  for (const r of nonVaultReads) countByFile.set(r.file_path, (countByFile.get(r.file_path) ?? 0) + 1);
  const topNFiles = [...countByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([file]) => file);
  const topNFileSet = new Set(topNFiles);

  const scopedReads = nonVaultReads.filter(r => !topNFileSet.has(r.file_path));

  // Per file, every prior read seen so far (session, timestamp) — small in
  // practice (bounded by re-read depth per file, not corpus size).
  const priorReadsByFile = new Map<string, Array<{ session: string; ts: number }>>();
  let rereadCount = 0;
  const rerereadFileCounts = new Map<string, number>();
  for (const r of scopedReads) {
    const ts = new Date(r.timestamp).getTime();
    const prior = priorReadsByFile.get(r.file_path) ?? [];
    const crossSessionPrior = prior.filter(p => p.session !== r.source_session_id);
    if (crossSessionPrior.length > 0) {
      const nearest = Math.max(...crossSessionPrior.map(p => p.ts));
      if (ts - nearest <= SEVEN_DAYS_MS) {
        rereadCount++;
        rerereadFileCounts.set(r.file_path, (rerereadFileCounts.get(r.file_path) ?? 0) + 1);
      }
    }
    prior.push({ session: r.source_session_id, ts });
    priorReadsByFile.set(r.file_path, prior);
  }

  const denominator = scopedReads.length;
  const sampleEvidence = [...rerereadFileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file]) => `file:${file}`);

  return {
    value: denominator > 0 ? rereadCount / denominator : null,
    numerator: rereadCount,
    denominator,
    excludedVaultReads: vaultReads.length,
    excludedTopNReads: nonVaultReads.length - scopedReads.length,
    excludedTopNFiles: topNFiles,
    sampleEvidence,
  };
}
