import { Storage, NCNode, NCWarning } from './storage.js';
import { GraphSnapshot } from './graph.js';
import { FlowDetector } from './flow.js';
import { loadEvolveConfig } from './nca.config.js';

export interface EvolveResult {
  warnings: NCWarning[];
  summary: string;
}

export class Evolver {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  analyze(rootPath?: string): EvolveResult {
    const cfg = loadEvolveConfig(rootPath);
    this.storage.clearWarnings();
    const warnings: NCWarning[] = [];

    const snap = GraphSnapshot.build(this.storage);

    if (snap.nodes.length === 0) {
      return { warnings: [], summary: 'NCA|evolve|no_nodes' };
    }

    // R001 High complexity
    for (const n of snap.nodes) {
      if (n.complexity >= cfg.complexityThreshold) {
        warnings.push({
          rule_id: 'R001',
          node_id: n.name,
          detail: `complexity=${n.complexity} exceeds threshold=${cfg.complexityThreshold}`,
        });
      }
    }

    // R002 Too many parameters
    for (const n of snap.nodes) {
      if (n.inputs.length > cfg.maxParamsThreshold) {
        warnings.push({
          rule_id: 'R002',
          node_id: n.name,
          detail: `params=${n.inputs.length} exceeds threshold=${cfg.maxParamsThreshold}`,
        });
      }
    }

    // R003 Too many dependencies
    for (const n of snap.nodes) {
      const deps = snap.forward.get(n.name) ?? new Set();
      if (deps.size > cfg.maxDepsThreshold) {
        warnings.push({
          rule_id: 'R003',
          node_id: n.name,
          detail: `deps=${deps.size} exceeds threshold=${cfg.maxDepsThreshold}`,
        });
      }
    }

    // R004 Cycles
    for (const cycle of snap.cycles) {
      warnings.push({
        rule_id: 'R004',
        node_id: cycle[0],
        detail: `cycle=[${cycle.join('->')}]`,
      });
    }

    // R005 Deep dependency chains
    const chains = findLongChains(snap, cfg.maxChainDepth);
    for (const chain of chains) {
      warnings.push({
        rule_id: 'R005',
        node_id: chain[0],
        detail: chain[1],
      });
    }

    // R006 Isolated nodes (no callers, no deps, not a top-level export)
    for (const n of snap.nodes) {
      const callers = snap.reverse.get(n.name) ?? new Set();
      const deps = snap.forward.get(n.name) ?? new Set();
      if (callers.size === 0 && deps.size === 0 && n.type !== 'class') {
        warnings.push({
          rule_id: 'R006',
          node_id: n.name,
          detail: `isolated node with no callers and no deps in ${n.file}`,
        });
      }
    }

    // Persist warnings
    for (const w of warnings) {
      this.storage.insertWarning(w);
    }

    // Refresh flow index so flows reflect current graph state
    const detector = new FlowDetector(this.storage, snap);
    detector.detectAll();

    const ts = Date.now();
    const lines: string[] = [`NCA|evolve|t:${ts}`, '[W]'];
    for (const w of warnings) {
      lines.push(`!${w.rule_id}:${w.node_id}:${w.detail}`);
    }
    if (warnings.length === 0) lines.push('(no warnings)');

    return { warnings, summary: lines.join('\n') };
  }
}

/**
 * Find chains in the dependency graph whose depth exceeds maxDepth.
 *
 * Cycle members are excluded from descent: if a node is part of a cycle
 * (per snap.cycleNodes), longestPath(that node) returns 0 and traversal
 * does not enter it. A non-cycle node depending on a cycle node still
 * counts the cycle node as length 1 but does not descend further into it.
 * This implements design decision C: "cycle node counts as terminal of
 * length 1, descent stops there".
 *
 * The remaining subgraph (with cycle members excluded) is a DAG, so the
 * per-node memo is correct: longestPath(node) is independent of the
 * traversal path that reached it.
 */
export function findLongChains(snap: GraphSnapshot, maxDepth: number): string[][] {
  const long: string[][] = [];
  const memo = new Map<string, number>();
  const { forward, cycleNodes } = snap;

  function longestPath(node: string): number {
    // A cycle node contributes 0 — it is excluded from chain measurement.
    if (cycleNodes.has(node)) return 0;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;

    const deps = forward.get(node) ?? new Set();
    let max = 0;
    for (const dep of deps) {
      let depLen: number;
      if (cycleNodes.has(dep)) {
        // Decision C: dep is a cycle node. Count it as length 1, stop descent.
        depLen = 1;
      } else {
        depLen = longestPath(dep);
      }
      if (depLen > max) max = depLen;
    }
    const result = max + 1;
    memo.set(node, result);
    return result;
  }

  for (const node of forward.keys()) {
    const depth = longestPath(node);
    if (depth > maxDepth) {
      long.push([node, `depth=${depth}`]);
    }
  }

  return long;
}
