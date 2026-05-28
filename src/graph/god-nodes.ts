import type { GraphSnapshot } from '../graph.js';

export interface GodNode {
  nodeKey: string;
  fanIn:   number;
  fanOut:  number;
  score:   number;
}

/**
 * God-node detection — percentile-based coupling threshold.
 *
 * A god node is one whose coupling score (fanIn + fanOut) exceeds the
 * Nth percentile of all scores in the graph. These are nodes that are
 * both heavily depended upon AND depend on many others — structural
 * coupling hotspots that tend to resist refactoring and accumulate bugs.
 *
 * fanIn  = number of distinct nodes that have an edge pointing TO this node
 * fanOut = number of distinct nodes this node has an edge pointing TO
 * score  = fanIn + fanOut
 *
 * Threshold: the score value at the given percentile (default 95).
 * Nodes with score > threshold are returned, sorted by score descending.
 * When all nodes share the same score, the threshold equals that score
 * and no node strictly exceeds it — empty result, no false positives.
 */
export function detectGodNodes(
  snap: GraphSnapshot,
  percentile = 95,
): GodNode[] {
  const { forward, reverse } = snap;

  if (forward.size === 0) return [];

  const entries: GodNode[] = [];
  for (const [key, deps] of forward) {
    const fanOut = deps.size;
    const fanIn  = reverse.get(key)?.size ?? 0;
    entries.push({ nodeKey: key, fanIn, fanOut, score: fanIn + fanOut });
  }

  // Compute the percentile threshold over all scores
  const sorted = entries.map(e => e.score).sort((a, b) => a - b);
  const idx = Math.floor((percentile / 100) * sorted.length);
  // Clamp: if idx === length, use the last element so the top node can still exceed it
  const threshold = sorted[Math.min(idx, sorted.length - 1)];

  return entries
    .filter(e => e.score > threshold)
    .sort((a, b) => b.score - a.score);
}
