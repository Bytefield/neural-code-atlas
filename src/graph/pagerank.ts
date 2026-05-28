import type { GraphSnapshot } from '../graph.js';

/**
 * PageRank centrality — iterative power method (Page et al., 1998).
 *
 * Uses the directed dependency graph as-is: an edge a→b means b is depended
 * upon by a, so rank flows from a into b (b is "cited" by a).
 *
 * Sink nodes (no outgoing edges) redistribute their accumulated rank uniformly
 * across all nodes via the dangling-node correction, preserving the stochastic
 * property (scores always sum to 1).
 *
 * Parameters:
 *   d   = 0.85  damping factor (probability of following an edge vs teleporting)
 *   tol = 1e-6  convergence threshold (max per-node delta between iterations)
 *   max = 100   iteration cap
 *
 * Returns Map<nodeKey, score> where scores are in (0, 1] and sum to 1.
 */
export function pagerank(snap: GraphSnapshot): Map<string, number> {
  const { forward } = snap;
  const nodeKeys = [...forward.keys()].sort(); // sort for determinism
  const N = nodeKeys.length;

  if (N === 0) return new Map();
  if (N === 1) return new Map([[nodeKeys[0], 1.0]]);

  const d   = 0.85;
  const tol = 1e-6;
  const max = 100;

  // ── Build in-link index and out-degree ───────────────────────────────────
  const outDegree = new Map<string, number>();
  const inLinks   = new Map<string, string[]>();

  for (const key of nodeKeys) {
    outDegree.set(key, 0);
    inLinks.set(key, []);
  }

  for (const [node, deps] of forward) {
    let degree = 0;
    for (const dep of deps) {
      if (dep === node) continue; // ignore self-loops
      degree++;
      if (!inLinks.has(dep)) inLinks.set(dep, []);
      inLinks.get(dep)!.push(node);
    }
    outDegree.set(node, degree);
  }

  // ── Iterative power method ───────────────────────────────────────────────
  // Initialise ranks uniformly.
  let ranks = new Map<string, number>();
  for (const key of nodeKeys) ranks.set(key, 1 / N);

  for (let iter = 0; iter < max; iter++) {
    // Dangling-node correction: collect rank of sink nodes and spread it
    // uniformly so that no probability mass is lost.
    let danglingSum = 0;
    for (const key of nodeKeys) {
      if (outDegree.get(key) === 0) danglingSum += ranks.get(key)!;
    }
    const teleport = (1 - d) / N + d * danglingSum / N;

    const next = new Map<string, number>();
    let maxDelta = 0;

    for (const node of nodeKeys) {
      // Accumulate rank passed through incoming edges.
      let linkSum = 0;
      for (const src of inLinks.get(node)!) {
        linkSum += ranks.get(src)! / outDegree.get(src)!;
      }
      const newRank = teleport + d * linkSum;
      next.set(node, newRank);
      const delta = Math.abs(newRank - ranks.get(node)!);
      if (delta > maxDelta) maxDelta = delta;
    }

    ranks = next;
    if (maxDelta < tol) break;
  }

  return ranks;
}
