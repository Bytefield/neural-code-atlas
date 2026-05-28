import type { GraphSnapshot } from '../graph.js';

/**
 * Louvain community detection — Phase 1 (local moving).
 *
 * Treats the directed dependency graph as undirected: an edge a→b is counted
 * as a↔b for modularity purposes. This reflects the reality that a strong
 * dependency relationship (even one-way) indicates structural proximity.
 *
 * Algorithm: iterative modularity optimisation (Blondel et al., 2008).
 * Each pass tries moving every node to its best neighbouring community.
 * Stops when no single move improves modularity.
 *
 * Phase 2 (super-node aggregation) is not implemented. Phase 1 alone produces
 * correct communities for codebases up to ~10 K nodes. At larger scales the
 * algorithm may converge to a local optimum rather than the global one.
 *
 * Modularity gain of moving isolated node i into community C:
 *   ΔQ = ki_C / m  −  (Σtot_C × ki) / (2m²)
 *
 * Where:
 *   ki_C   = sum of edge weights between i and nodes in C
 *   Σtot_C = sum of all degrees of nodes in C
 *   ki     = degree of node i
 *   m      = total number of undirected edges
 *
 * Returns Map<nodeKey, communityId> where nodeKey is the "file:name" composite
 * key used throughout GraphSnapshot. Community IDs are contiguous integers
 * starting at 0, ordered by first occurrence in sorted node order.
 */
export function louvain(snap: GraphSnapshot): Map<string, number> {
  const { forward } = snap;

  // Sort for deterministic output regardless of Map insertion order.
  const nodeKeys = [...forward.keys()].sort();

  if (nodeKeys.length === 0) return new Map();

  // ── Build undirected adjacency ──────────────────────────────────────────
  // Each directed edge a→b becomes the undirected pair a↔b (counted once).

  const adj = new Map<string, Map<string, number>>();
  for (const key of nodeKeys) adj.set(key, new Map());

  let m = 0;
  const edgeSeen = new Set<string>();

  for (const [node, deps] of forward) {
    for (const dep of deps) {
      if (node === dep) continue;
      // Canonical key: smaller string first so a→b and b→a collapse to one edge.
      const edgeKey = node < dep ? `${node}\0${dep}` : `${dep}\0${node}`;
      if (edgeSeen.has(edgeKey)) continue;
      edgeSeen.add(edgeKey);

      if (!adj.has(dep)) adj.set(dep, new Map());
      adj.get(node)!.set(dep, 1);
      adj.get(dep)!.set(node, 1);
      m++;
    }
  }

  // No edges: every node is its own community.
  if (m === 0) {
    const result = new Map<string, number>();
    nodeKeys.forEach((key, i) => result.set(key, i));
    return result;
  }

  const m2 = 2 * m; // used in denominator of gain formula

  // ── Degrees ─────────────────────────────────────────────────────────────
  const degree = new Map<string, number>();
  for (const [node, neighbours] of adj) {
    let d = 0;
    for (const w of neighbours.values()) d += w;
    degree.set(node, d);
  }

  // ── Initialise: each node is its own community ───────────────────────────
  // Community IDs are node indices (0…n-1) for stable initial assignment.
  const node2comm = new Map<string, number>();
  nodeKeys.forEach((key, i) => node2comm.set(key, i));

  // sigmaTot[c] = sum of degrees of all nodes in community c
  // sigmaIn[c]  = sum of internal edge weights (each undirected edge counted once)
  const sigmaTot = new Map<number, number>();
  const sigmaIn  = new Map<number, number>();
  nodeKeys.forEach((key, i) => {
    sigmaTot.set(i, degree.get(key)!);
    sigmaIn.set(i, 0);
  });

  // ── Phase 1: local moving ────────────────────────────────────────────────
  let improved = true;
  while (improved) {
    improved = false;

    for (const node of nodeKeys) {
      const currentComm = node2comm.get(node)!;
      const ki          = degree.get(node)!;

      // Aggregate edge weights to each neighbouring community.
      const weightToComm = new Map<number, number>();
      for (const [neighbour, w] of adj.get(node)!) {
        const nc = node2comm.get(neighbour)!;
        weightToComm.set(nc, (weightToComm.get(nc) ?? 0) + w);
      }

      const ki_in_current = weightToComm.get(currentComm) ?? 0;

      // Remove node from its current community.
      // sigmaIn drops by the edges that were internal because of this node.
      // sigmaTot drops by this node's total degree.
      sigmaIn.set(currentComm,  sigmaIn.get(currentComm)!  - ki_in_current);
      sigmaTot.set(currentComm, sigmaTot.get(currentComm)! - ki);

      // Gain of re-adding node to currentComm (using its post-removal state).
      // This is the baseline: any candidate must beat staying put.
      const gainStay =
        ki_in_current / m -
        (sigmaTot.get(currentComm)! * ki) / (m2 * m);

      let bestComm = currentComm;
      let bestGain = gainStay;

      // Evaluate every neighbouring community (excluding currentComm,
      // which was already evaluated as gainStay above).
      for (const [commId, ki_in_C] of weightToComm) {
        if (commId === currentComm) continue;
        const gain =
          ki_in_C / m -
          (sigmaTot.get(commId)! * ki) / (m2 * m);
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = commId;
        }
      }

      // Place node in the winning community and update bookkeeping.
      const ki_in_best = weightToComm.get(bestComm) ?? 0;
      sigmaIn.set(bestComm,  (sigmaIn.get(bestComm)  ?? 0) + ki_in_best);
      sigmaTot.set(bestComm, (sigmaTot.get(bestComm) ?? 0) + ki);
      node2comm.set(node, bestComm);

      if (bestComm !== currentComm) improved = true;
    }
  }

  // ── Renumber communities to contiguous integers ──────────────────────────
  // Traversed in sorted node order so community 0 is the one containing the
  // lexicographically smallest node key.
  const commRemap = new Map<number, number>();
  let nextId = 0;
  const result = new Map<string, number>();
  for (const node of nodeKeys) {
    const c = node2comm.get(node)!;
    if (!commRemap.has(c)) commRemap.set(c, nextId++);
    result.set(node, commRemap.get(c)!);
  }

  return result;
}
