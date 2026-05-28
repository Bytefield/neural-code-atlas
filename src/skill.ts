import * as path from 'path';
import { Storage } from './storage.js';
import { GraphSnapshot } from './graph.js';
import { pagerank } from './graph/pagerank.js';
import { detectGodNodes } from './graph/god-nodes.js';
import { findLongChains } from './evolve.js';
import { defaultConfig } from './nca.config.js';

const HARD_CAP = 8000;

/**
 * Generates a SKILL.md string from an existing NCA database.
 * Deterministic: same DB state → identical output.
 */
export function generateSkill(dbPath: string): string {
  const storage = new Storage(dbPath);
  try {
    return buildSkill(dbPath, storage);
  } finally {
    storage.close();
  }
}

function buildSkill(dbPath: string, storage: Storage): string {
  const snap = GraphSnapshot.build(storage);
  const stats = storage.stats();

  // Project name = root dir basename (parent of .nca/)
  const ncaDir = path.dirname(dbPath);
  const projectRoot = path.dirname(ncaDir);
  const projectName = path.basename(projectRoot);

  // Last scan date from file_index MAX(parsed_at)
  const lastScanRow = storage.db
    .prepare(`SELECT MAX(parsed_at) as last_scan FROM file_index`)
    .get() as { last_scan: number | null };
  const lastScan = lastScanRow?.last_scan
    ? new Date(lastScanRow.last_scan * 1000).toISOString().slice(0, 10)
    : 'unknown';

  // Edge count = sum of all forward-edge set sizes
  let edgeCount = 0;
  for (const deps of snap.forward.values()) edgeCount += deps.size;

  const sections: string[] = [];

  // ── Section 1: Header ─────────────────────────────────────────────────────
  sections.push(
    `# NCA SKILL — ${projectName}\n` +
    `nodes:${stats.nodes} files:${stats.files} edges:${edgeCount} scanned:${lastScan}`
  );

  // ── Section 2: Modules (top-level source dirs) ────────────────────────────
  const rootPrefix = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const moduleCounts = new Map<string, number>();
  for (const n of snap.nodes) {
    const normalized = n.file.replace(/\\/g, '/');
    // Strip the project root prefix to get a relative path
    const rel = normalized.startsWith(rootPrefix)
      ? normalized.slice(rootPrefix.length)
      : normalized;
    const parts = rel.split('/');
    // Top-level dir if there is one; otherwise the file lives at root
    const mod = parts.length > 1 ? parts[0] : '(root)';
    moduleCounts.set(mod, (moduleCounts.get(mod) ?? 0) + 1);
  }
  const modulesLines = [...moduleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([mod, count]) => `  ${mod}: ${count} nodes`);
  sections.push(`## Modules\n${modulesLines.join('\n') || '  (none)'}`);

  // ── Section 3: Top 20 nodes by PageRank ───────────────────────────────────
  if (snap.nodes.length > 0) {
    const ranks = pagerank(snap);
    const nodeComplexity = new Map<string, number>();
    for (const n of snap.nodes) {
      nodeComplexity.set(`${n.file}:${n.name}`, n.complexity);
    }

    const ranked = [...ranks.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const top20Lines = ranked.map(([key, _score]) => {
      const fanIn = snap.reverse.get(key)?.size ?? 0;
      const fanOut = snap.forward.get(key)?.size ?? 0;
      const complexity = nodeComplexity.get(key) ?? 0;
      return `  ${key} fanIn:${fanIn} fanOut:${fanOut} complexity:${complexity}`;
    });
    sections.push(`## Top Nodes (PageRank)\n${top20Lines.join('\n')}`);
  } else {
    sections.push(`## Top Nodes (PageRank)\n  (no nodes)`);
  }

  // ── Section 4: God nodes ──────────────────────────────────────────────────
  const godNodes = detectGodNodes(snap);
  if (godNodes.length > 0) {
    const godLines = godNodes.map(
      g => `  ${g.nodeKey} fanIn:${g.fanIn} fanOut:${g.fanOut} score:${g.score}`
    );
    sections.push(`## God Nodes\n${godLines.join('\n')}`);
  } else {
    sections.push(`## God Nodes\n  (none)`);
  }

  // ── Section 5: Issues ─────────────────────────────────────────────────────
  const cycleCount = snap.cycles.length;
  const maxChainDepth = defaultConfig.evolve.maxChainDepth;
  const chains = findLongChains(snap, maxChainDepth);
  const chainCount = chains.length;
  sections.push(
    `## Issues\n  cycles:${cycleCount} long-chains:${chainCount} (chain threshold:${maxChainDepth})`
  );

  // ── Section 6: MCP tools ──────────────────────────────────────────────────
  sections.push(
    `## MCP Tools\n` +
    `  nca_ask(query, project?) — search functions/classes by name or concept\n` +
    `  nca_status(project?) — index statistics\n` +
    `  nca_projects() — list indexed projects`
  );

  const output = sections.join('\n\n') + '\n';

  if (output.length <= HARD_CAP) return output;

  // Truncate from bottom, keeping header + modules (first two sections)
  const keep = sections.slice(0, 2).join('\n\n') + '\n\n';
  const truncMsg = `<!-- truncated: output exceeded ${HARD_CAP} chars -->\n`;
  return keep + truncMsg;
}
