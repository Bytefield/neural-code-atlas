import { Storage, NCNode, NCWarning } from './storage.js';
import { Linker } from './linker.js';
import { FlowDetector } from './flow.js';
import { loadEvolveConfig } from './nca.config.js';

export interface EvolveResult {
  warnings: NCWarning[];
  summary: string;
}

export class Evolver {
  private storage: Storage;
  private linker: Linker;

  constructor(storage: Storage) {
    this.storage = storage;
    this.linker = new Linker(storage);
  }

  analyze(rootPath?: string): EvolveResult {
    const cfg = loadEvolveConfig(rootPath);
    this.storage.clearWarnings();
    const warnings: NCWarning[] = [];

    const nodes = this.storage.getAllNodes();
    if (nodes.length === 0) {
      return { warnings: [], summary: 'NCA|evolve|no_nodes' };
    }

    const graph = this.linker.buildDepGraph();

    // R001 High complexity
    for (const n of nodes) {
      if (n.complexity >= cfg.complexityThreshold) {
        warnings.push({
          rule_id: 'R001',
          node_id: n.name,
          detail: `complexity=${n.complexity} exceeds threshold=${cfg.complexityThreshold}`,
        });
      }
    }

    // R002 Too many parameters
    for (const n of nodes) {
      if (n.inputs.length > cfg.maxParamsThreshold) {
        warnings.push({
          rule_id: 'R002',
          node_id: n.name,
          detail: `params=${n.inputs.length} exceeds threshold=${cfg.maxParamsThreshold}`,
        });
      }
    }

    // R003 Too many dependencies
    for (const n of nodes) {
      const deps = graph.get(n.name) ?? new Set();
      if (deps.size > cfg.maxDepsThreshold) {
        warnings.push({
          rule_id: 'R003',
          node_id: n.name,
          detail: `deps=${deps.size} exceeds threshold=${cfg.maxDepsThreshold}`,
        });
      }
    }

    // R004 Cycles
    const cycles = detectCycles(graph);
    for (const cycle of cycles) {
      warnings.push({
        rule_id: 'R004',
        node_id: cycle[0],
        detail: `cycle=[${cycle.join('->')}]`,
      });
    }

    // R005 Deep dependency chains
    const chains = findLongChains(graph, cfg.maxChainDepth);
    for (const chain of chains) {
      warnings.push({
        rule_id: 'R005',
        node_id: chain[0],
        detail: `chain_depth=${chain.length} path=${chain.slice(0, 4).join('->')}...`,
      });
    }

    // R006 Isolated nodes (no callers, no deps, not a top-level export)
    const reverseGraph = this.linker.buildReverseDepGraph();
    for (const n of nodes) {
      const callers = reverseGraph.get(n.name) ?? new Set();
      const deps = graph.get(n.name) ?? new Set();
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
    const detector = new FlowDetector(this.storage);
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

function detectCycles(graph: Map<string, Set<string>>): string[][] {
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

  // Deduplicate cycles
  const seen = new Set<string>();
  return cycles.filter(c => {
    const key = [...c].sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findLongChains(graph: Map<string, Set<string>>, maxDepth: number): string[][] {
  const long: string[][] = [];
  const memo = new Map<string, number>();

  function longestPath(node: string, visited: Set<string>): number {
    if (memo.has(node)) return memo.get(node)!;
    if (visited.has(node)) return 0;

    visited.add(node);
    const deps = graph.get(node) ?? new Set();
    let max = 0;
    for (const dep of deps) {
      const len = longestPath(dep, new Set(visited));
      if (len > max) max = len;
    }
    const result = max + 1;
    memo.set(node, result);
    return result;
  }

  for (const node of graph.keys()) {
    const depth = longestPath(node, new Set());
    if (depth > maxDepth) {
      long.push([node, `depth=${depth}`]);
    }
  }

  return long;
}
