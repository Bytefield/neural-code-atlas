import type { GraphSnapshot } from '../graph.js';

/**
 * Betweenness centrality — Brandes algorithm (Brandes, 2001).
 * DOI: https://doi.org/10.1080/0022250X.2001.9990249
 *
 * For each node v, betweenness counts the fraction of all shortest paths
 * between pairs (s, t) that pass through v. The directed graph is used
 * as-is: edge a→b means b is depended upon by a (following edge direction
 * for shortest-path traversal).
 *
 * Complexity: O(V·E) — one BFS per source node.
 *
 * Normalization: divide by (n−1)·(n−2), the maximum number of ordered
 * pairs excluding v, so scores are in [0, 1].
 *
 * Returns Map<nodeKey, score> where score ∈ [0, 1].
 * Nodes that lie on no shortest path score 0 (including single nodes).
 */
export function betweenness(snap: GraphSnapshot): Map<string, number> {
  const { forward } = snap;
  const nodes = [...forward.keys()];
  const N = nodes.length;

  if (N === 0) return new Map();

  // Initialise raw scores to 0 for every node
  const delta = new Map<string, number>();
  for (const v of nodes) delta.set(v, 0);

  if (N === 1) return delta;

  // ── Brandes: one BFS per source ─────────────────────────────────────────
  for (const s of nodes) {
    // Stack of nodes in order of non-decreasing distance from s
    const stack: string[] = [];
    // Predecessors on shortest paths from s
    const pred = new Map<string, string[]>();
    for (const v of nodes) pred.set(v, []);

    // Number of shortest paths from s to v
    const sigma = new Map<string, number>();
    for (const v of nodes) sigma.set(v, 0);
    sigma.set(s, 1);

    // Distance from s to v (-1 = unvisited)
    const dist = new Map<string, number>();
    for (const v of nodes) dist.set(v, -1);
    dist.set(s, 0);

    const queue: string[] = [s];
    let qi = 0;

    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);

      for (const w of (forward.get(v) ?? [])) {
        if (!forward.has(w)) continue; // skip nodes not in the graph key set

        // First visit to w?
        if (dist.get(w) === -1) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        // Shortest path to w via v?
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }

    // ── Back-propagate dependencies ──────────────────────────────────────
    const dp = new Map<string, number>(); // dependency accumulator
    for (const v of nodes) dp.set(v, 0);

    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        const contribution = (sigma.get(v)! / sigma.get(w)!) * (1 + dp.get(w)!);
        dp.set(v, dp.get(v)! + contribution);
      }
      if (w !== s) {
        delta.set(w, delta.get(w)! + dp.get(w)!);
      }
    }
  }

  // ── Normalize by (n-1)*(n-2) ────────────────────────────────────────────
  const norm = (N - 1) * (N - 2);
  const result = new Map<string, number>();
  for (const [v, score] of delta) {
    result.set(v, norm > 0 ? score / norm : 0);
  }

  return result;
}
