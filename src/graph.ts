import { Storage, NCNode } from './storage.js';

/**
 * Immutable snapshot of the code graph at a point in time.
 * Built once per analysis pass; consumed by Evolver, FlowDetector, and any future analyser.
 *
 * All fields are readonly. Construct via GraphSnapshot.build(storage) or GraphSnapshot.fromMaps()
 * for testing.
 */
export class GraphSnapshot {
  readonly nodes: readonly NCNode[];
  readonly nodesByName: ReadonlyMap<string, NCNode>;
  readonly forward: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reverse: ReadonlyMap<string, ReadonlySet<string>>;
  readonly cycles: readonly (readonly string[])[];
  readonly cycleNodes: ReadonlySet<string>;

  private constructor(
    nodes: readonly NCNode[],
    nodesByName: ReadonlyMap<string, NCNode>,
    forward: ReadonlyMap<string, ReadonlySet<string>>,
    reverse: ReadonlyMap<string, ReadonlySet<string>>,
    cycles: readonly (readonly string[])[],
    cycleNodes: ReadonlySet<string>
  ) {
    this.nodes = nodes;
    this.nodesByName = nodesByName;
    this.forward = forward;
    this.reverse = reverse;
    this.cycles = cycles;
    this.cycleNodes = cycleNodes;
  }

  /**
   * Single entry point: reads nodes once from storage, computes everything else.
   */
  static build(storage: Storage): GraphSnapshot {
    const nodes = storage.getAllNodes();
    const nodesByName = new Map<string, NCNode>();
    for (const n of nodes) nodesByName.set(n.name, n);

    const forward = buildForward(nodes);
    const reverse = invertGraph(forward);
    const cycles = detectCycles(forward);
    const cycleNodes = new Set<string>();
    for (const cycle of cycles) for (const n of cycle) cycleNodes.add(n);

    return new GraphSnapshot(nodes, nodesByName, forward, reverse, cycles, cycleNodes);
  }

  /**
   * Test-only constructor. Allows building synthetic snapshots without a Storage.
   * Do not use in production code.
   */
  static fromMaps(
    nodes: readonly NCNode[],
    forward: ReadonlyMap<string, ReadonlySet<string>>
  ): GraphSnapshot {
    const nodesByName = new Map<string, NCNode>();
    for (const n of nodes) nodesByName.set(n.name, n);
    const reverse = invertGraph(forward);
    const cycles = detectCycles(forward);
    const cycleNodes = new Set<string>();
    for (const cycle of cycles) for (const n of cycle) cycleNodes.add(n);
    return new GraphSnapshot(nodes, nodesByName, forward, reverse, cycles, cycleNodes);
  }
}

// ---- Pure helpers ----

/**
 * Builds the forward dependency map. Only edges to known node names are included,
 * matching the behaviour of the former Linker.buildDepGraph().
 */
function buildForward(nodes: readonly NCNode[]): Map<string, Set<string>> {
  const nameSet = new Set(nodes.map(n => n.name));
  const graph = new Map<string, Set<string>>();
  for (const n of nodes) {
    const deps = new Set(n.deps.filter(d => nameSet.has(d)));
    graph.set(n.name, deps);
  }
  return graph;
}

export function invertGraph(
  graph: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [from, deps] of graph) {
    if (!reverse.has(from)) reverse.set(from, new Set());
    for (const to of deps) {
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to)!.add(from);
    }
  }
  return reverse;
}

/**
 * Detects all simple cycles in the dependency graph. Returns one path per distinct cycle.
 * Moved verbatim from evolve.ts — no behavioural changes.
 */
export function detectCycles(
  graph: ReadonlyMap<string, ReadonlySet<string>>
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (recStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    recStack.add(node);
    path.push(node);

    const deps = graph.get(node) ?? new Set();
    for (const dep of deps) {
      dfs(dep, [...path]);
    }

    recStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  const seen = new Set<string>();
  return cycles.filter(c => {
    const key = [...c].sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
