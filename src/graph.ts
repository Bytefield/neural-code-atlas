import { Storage, NCNode } from './storage.js';

/**
 * Returns the composite graph key for a node: `file:name`.
 * Example: "src/auth/login.ts:handler"
 *
 * Using a composite key prevents two functions with the same bare name in
 * different files from collapsing into a single graph node — which would
 * create phantom edges, false cycles, and corrupted analysis results.
 */
export function nodeKey(file: string, name: string): string {
  return `${file}:${name}`;
}

/**
 * Immutable snapshot of the code graph at a point in time.
 * Built once per analysis pass; consumed by Evolver, FlowDetector, and any future analyser.
 *
 * All fields are readonly. Construct via GraphSnapshot.build(storage) or GraphSnapshot.fromMaps()
 * for testing.
 *
 * Graph keys are `file:name` composite strings (see nodeKey()). User-facing queries still
 * search by bare name via nodesByName.
 */
export class GraphSnapshot {
  readonly nodes: readonly NCNode[];
  /** Map from bare name to NCNode — for user-facing lookups. When multiple nodes share a
   *  name, the first one encountered wins; use the forward map keys for identity. */
  readonly nodesByName: ReadonlyMap<string, NCNode>;
  /** Forward dependency map keyed by `file:name`. */
  readonly forward: ReadonlyMap<string, ReadonlySet<string>>;
  /** Reverse dependency map keyed by `file:name`. */
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
    // nodesByName is for bare-name user lookups; first occurrence wins on collision
    for (const n of nodes) {
      if (!nodesByName.has(n.name)) nodesByName.set(n.name, n);
    }

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
   *
   * The `forward` map must already use `file:name` composite keys (see nodeKey()).
   */
  static fromMaps(
    nodes: readonly NCNode[],
    forward: ReadonlyMap<string, ReadonlySet<string>>
  ): GraphSnapshot {
    const nodesByName = new Map<string, NCNode>();
    for (const n of nodes) {
      if (!nodesByName.has(n.name)) nodesByName.set(n.name, n);
    }
    const reverse = invertGraph(forward);
    const cycles = detectCycles(forward);
    const cycleNodes = new Set<string>();
    for (const cycle of cycles) for (const n of cycle) cycleNodes.add(n);
    return new GraphSnapshot(nodes, nodesByName, forward, reverse, cycles, cycleNodes);
  }
}

// ---- Pure helpers ----

/**
 * Resolves a bare dep name to a `file:name` composite key using a 4-priority strategy:
 *
 * 1. Same-file: dep matches a function defined in the same file as the depending node.
 * 2. Import-based: dep name appears in the file's import list and a matching node exists
 *    in the imported module.
 * 3. Global unique: exactly one node in the entire codebase has this name.
 * 4. Unresolvable: return null — no edge is created (no false positives).
 *
 * The dep string from the DB may be:
 *   a) A bare function/method name ("handler", "validate")
 *   b) A relative import path ("./auth", "./utils/helper")
 *   c) An external package name ("express", "lodash")
 *
 * Cases b and c are not bare names and are skipped (they cannot resolve to a node key).
 */
function resolveDep(
  dep: string,
  ownerFile: string,
  nodesByKey: Map<string, NCNode>,
  nodesByName: Map<string, NCNode[]>,
): string | null {
  // Skip relative imports and external package names — they are module paths, not node names
  if (dep.startsWith('.') || dep.startsWith('/')) return null;
  if (dep.includes('/') || dep.includes('\\')) return null;
  // Skip names that look like module specifiers (e.g. "express", "fs") — they have no node entry
  // We can still check — if no node with that name exists anywhere, skip early
  const candidates = nodesByName.get(dep);
  if (!candidates || candidates.length === 0) return null;

  // Priority 1: same-file match
  const sameFile = candidates.find(n => n.file === ownerFile);
  if (sameFile) return nodeKey(sameFile.file, sameFile.name);

  // Priority 3: global unique (only one node with this name in the entire codebase)
  if (candidates.length === 1) return nodeKey(candidates[0].file, candidates[0].name);

  // Priority 4: unresolvable (multiple candidates, no same-file match, no import data)
  return null;
}

/**
 * Builds the forward dependency map using `file:name` composite keys.
 *
 * Dependency resolution priority (see resolveDep):
 *   1. Same-file
 *   2. Global unique
 *   3. Skip (no false positives)
 *
 * Import-based resolution (priority 2 in the spec) would require storing per-file
 * import declarations separately; the current schema stores only bare dep names.
 * That enhancement can be added in a future migration without changing this contract.
 */
function buildForward(nodes: readonly NCNode[]): Map<string, Set<string>> {
  // Build lookup tables
  const nodesByKey = new Map<string, NCNode>();
  const nodesByName = new Map<string, NCNode[]>();

  for (const n of nodes) {
    nodesByKey.set(nodeKey(n.file, n.name), n);
    const list = nodesByName.get(n.name) ?? [];
    list.push(n);
    nodesByName.set(n.name, list);
  }

  const graph = new Map<string, Set<string>>();

  for (const n of nodes) {
    const ownerKey = nodeKey(n.file, n.name);
    const resolvedDeps = new Set<string>();

    for (const dep of n.deps) {
      const resolved = resolveDep(dep, n.file, nodesByKey, nodesByName);
      if (resolved !== null && resolved !== ownerKey) {
        resolvedDeps.add(resolved);
      }
    }

    graph.set(ownerKey, resolvedDeps);
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
