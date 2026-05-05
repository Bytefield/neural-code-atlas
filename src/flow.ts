import { Storage, NCNode, NCFlow } from './storage.js';
import { GraphSnapshot } from './graph.js';

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
    const steps: string[] = [];
    const visited = new Set<string>();
    const cycleNodes = new Set<string>();
    let cycleDetected = false;
    let truncated = false;

    // BFS
    const queue: Array<{ name: string; depth: number }> = [{ name: entryName, depth: 0 }];
    const inQueue = new Set<string>([entryName]);

    while (queue.length > 0) {
      const { name, depth } = queue.shift()!;

      if (visited.has(name)) {
        cycleDetected = true;
        cycleNodes.add(name);
        continue;
      }

      if (depth > MAX_DEPTH) {
        truncated = true;
        continue;
      }

      visited.add(name);
      steps.push(name);

      const deps = graph.get(name) ?? new Set();
      for (const dep of deps) {
        if (visited.has(dep)) {
          cycleDetected = true;
          cycleNodes.add(dep);
        } else if (!inQueue.has(dep)) {
          inQueue.add(dep);
          queue.push({ name: dep, depth: depth + 1 });
        }
      }
    }

    return { name: entryName, steps, cycleDetected, truncated };
  }

  detectAll(): FlowResult[] {
    const graph = this.snap.forward;
    const results: FlowResult[] = [];
    const allNames = new Set(graph.keys());

    const reverseGraph = this.snap.reverse;
    const entryPoints: string[] = [];

    for (const name of allNames) {
      const callers = reverseGraph.get(name) ?? new Set();
      if (callers.size === 0) {
        entryPoints.push(name);
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
