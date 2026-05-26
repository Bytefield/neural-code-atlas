import { Storage, NCNode, NCFlow } from './storage.js';
import { GraphSnapshot, nodeKey } from './graph.js';

const MAX_DEPTH = 10;

export interface FlowResult {
  name: string;
  steps: string[];
  cycleDetected: boolean;
  truncated: boolean;
}

export class FlowDetector {
  private storage: Storage;
  private snap: GraphSnapshot;

  constructor(storage: Storage, snap?: GraphSnapshot) {
    this.storage = storage;
    this.snap = snap ?? GraphSnapshot.build(storage);
  }

  detect(entryName: string): FlowResult {
    const graph = this.snap.forward;

    // Resolve entry point: find the node with the given bare name and build its key.
    // If multiple nodes share the name, use the first one (nodesByName is first-wins).
    const entryNode = this.snap.nodesByName.get(entryName);
    const startKey = entryNode ? nodeKey(entryNode.file, entryNode.name) : entryName;

    const steps: string[] = [];
    const visited = new Set<string>();
    const cycleNodes = new Set<string>();
    let cycleDetected = false;
    let truncated = false;

    // BFS over composite `file:name` keys; output bare names for readability
    const queue: Array<{ key: string; depth: number }> = [{ key: startKey, depth: 0 }];
    const inQueue = new Set<string>([startKey]);

    while (queue.length > 0) {
      const { key, depth } = queue.shift()!;

      if (visited.has(key)) {
        cycleDetected = true;
        cycleNodes.add(key);
        continue;
      }

      if (depth > MAX_DEPTH) {
        truncated = true;
        continue;
      }

      visited.add(key);
      // Output the bare name portion for human-readable flow output
      const bareName = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
      steps.push(bareName);

      const deps = graph.get(key) ?? new Set();
      for (const dep of deps) {
        if (visited.has(dep)) {
          cycleDetected = true;
          cycleNodes.add(dep);
        } else if (!inQueue.has(dep)) {
          inQueue.add(dep);
          queue.push({ key: dep, depth: depth + 1 });
        }
      }
    }

    return { name: entryName, steps, cycleDetected, truncated };
  }

  detectAll(): FlowResult[] {
    const graph = this.snap.forward;
    const results: FlowResult[] = [];

    const reverseGraph = this.snap.reverse;
    // Entry points are nodes with no callers (nothing depends on them).
    // Keys are `file:name` composite — extract bare name for the detect() call.
    const entryPoints: string[] = [];

    for (const key of graph.keys()) {
      const callers = reverseGraph.get(key) ?? new Set();
      if (callers.size === 0) {
        const bareName = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
        entryPoints.push(bareName);
      }
    }

    for (const entry of entryPoints) {
      const result = this.detect(entry);
      if (result.steps.length > 1) {
        results.push(result);
        // Always persist — covers both new flows and re-traces after re-scan
        this.storage.upsertFlow({ name: entry, steps: result.steps });
      }
    }

    return results;
  }

  formatFlow(result: FlowResult): string {
    const stepStr = result.steps.join('>');
    let out = `#${result.name}[${stepStr}]`;
    if (result.cycleDetected) out += ' !CYCLE';
    if (result.truncated) out += ' !TRUNCATED';
    return out;
  }
}
