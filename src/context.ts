import { Storage, NCNode } from './storage.js';

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 600;
const MAX_CHARS = MAX_TOKENS * APPROX_CHARS_PER_TOKEN;

export interface QueryResult {
  query: string;
  nodes: NCNode[];
  timestamp: number;
}

export class ContextExpander {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Expand context around a set of seed nodes by following deps up to `depth` hops.
   */
  expand(seeds: NCNode[], depth: number = 2): NCNode[] {
    const seen = new Map<number, NCNode>();
    for (const n of seeds) if (n.id !== undefined) seen.set(n.id, n);

    let frontier = [...seeds];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: NCNode[] = [];
      for (const node of frontier) {
        const deps = this.storage.getNodeDepNodes(node);
        for (const dep of deps) {
          if (dep.id !== undefined && !seen.has(dep.id)) {
            seen.set(dep.id, dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
    }

    return [...seen.values()];
  }

  /**
   * Score-based ranking. Higher complexity + more deps = higher relevance.
   * Boost if query terms appear in name/module.
   */
  rank(nodes: NCNode[], query: string): NCNode[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    return nodes
      .map(n => {
        let score = 0;
        const haystack = `${n.name} ${n.module} ${n.inputs.join(' ')} ${n.file}`.toLowerCase();
        for (const term of terms) {
          if (haystack.includes(term)) score += 10;
          if (n.name.toLowerCase().includes(term)) score += 20;
        }
        score += Math.min(n.complexity, 10); // up to 10 bonus for complex nodes
        score += Math.min(n.deps.length, 5);
        return { node: n, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.node);
  }

  /**
   * Like rank() but applies stored query-frequency boost from node_scores.
   * Frequently-queried nodes surface higher over time.
   */
  rankWithBoost(nodes: NCNode[], query: string): NCNode[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    return nodes
      .map(n => {
        let score = 0;
        const haystack = `${n.name} ${n.module} ${n.inputs.join(' ')} ${n.file}`.toLowerCase();
        for (const term of terms) {
          if (haystack.includes(term)) score += 10;
          if (n.name.toLowerCase().includes(term)) score += 20;
        }
        score += Math.min(n.complexity, 10);
        score += Math.min(n.deps.length, 5);
        if (n.id !== undefined) {
          score += this.storage.getNodeBoost(String(n.id)) * 100;
        }
        return { node: n, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.node);
  }

  /**
   * Format query result as the NCA output contract string.
   */
  format(result: QueryResult): string {
    const ranked = this.rankWithBoost(this.expand(result.nodes, 2), result.query);
    const lines: string[] = [];

    lines.push(`NCA|q:${result.query}|t:${result.timestamp}`);
    lines.push('[N]');

    let nodeCount = 0;
    for (const n of ranked) {
      const entry = formatNode(n);
      lines.push(entry);
      nodeCount++;
    }

    if (ranked.length === 0) {
      lines.push('(no results)');
    }

    // Add CTX entry for the top result
    if (ranked.length > 0) {
      const top = ranked[0];
      const confidence = calcConfidence(top, result.query);
      lines.push('[CTX]');
      lines.push(`entry:${top.file}:${top.line}|scope:${top.module}|confidence:${confidence.toFixed(2)}`);
    }

    const output = lines.join('\n');

    // Hard truncate at 600 tokens
    if (output.length > MAX_CHARS) {
      const truncated = output.slice(0, MAX_CHARS);
      const omitted = nodeCount - countNodes(truncated);
      return truncated + `\nNCA|truncated|${omitted}_nodes_omitted`;
    }

    return output;
  }

  /**
   * Format with explicit flow and warning sections.
   */
  formatFull(
    result: QueryResult,
    flows: Array<{ name: string; steps: string[] }>,
    warnings: Array<{ rule_id: string; node_id: string; detail: string }>
  ): string {
    const ranked = this.rankWithBoost(this.expand(result.nodes, 2), result.query);
    const lines: string[] = [];

    lines.push(`NCA|q:${result.query}|t:${result.timestamp}`);
    lines.push('[N]');
    for (const n of ranked) lines.push(formatNode(n));
    if (ranked.length === 0) lines.push('(no results)');

    if (flows.length > 0) {
      lines.push('[F]');
      for (const f of flows) {
        lines.push(`#${f.name}[${f.steps.join('>')}]`);
      }
    }

    if (warnings.length > 0) {
      lines.push('[W]');
      for (const w of warnings) {
        lines.push(`!${w.rule_id}:${w.node_id}:${w.detail}`);
      }
    }

    if (ranked.length > 0) {
      const top = ranked[0];
      const confidence = calcConfidence(top, result.query);
      lines.push('[CTX]');
      lines.push(`entry:${top.file}:${top.line}|scope:${top.module}|confidence:${confidence.toFixed(2)}`);
    }

    const output = lines.join('\n');
    if (output.length > MAX_CHARS) {
      const nodeCount = ranked.length;
      const truncated = output.slice(0, MAX_CHARS);
      const omitted = nodeCount - countNodes(truncated);
      return truncated + `\nNCA|truncated|${omitted}_nodes_omitted`;
    }
    return output;
  }
}

function formatNode(n: NCNode): string {
  const i = n.inputs.slice(0, 5).join(',');
  const o = n.outputs.slice(0, 3).join(',');
  const d = n.deps
    .filter(dep => !dep.startsWith('.') && dep.length < 40)
    .slice(0, 5)
    .join(',');
  const e = n.effects.slice(0, 3).join(',');
  return `@${n.type}.${n.name}{m:${n.module}|i:${i}|o:${o}|d:${d}|e:${e}|cx:${n.complexity}|f:${n.file}:${n.line}}`;
}

function calcConfidence(n: NCNode, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const nameLC = n.name.toLowerCase();
  let matches = 0;
  for (const t of terms) {
    if (nameLC.includes(t)) matches++;
  }
  if (terms.length === 0) return 0.5;
  return Math.min(matches / terms.length, 1.0);
}

function countNodes(text: string): number {
  return (text.match(/^@/gm) ?? []).length;
}

export interface QueryJSON {
  query: string;
  timestamp: number;
  nodes: NCNode[];
  flows: Array<{ name: string; steps: string[] }>;
  warnings: Array<{ rule_id: string; node_id: string; detail: string }>;
  ctx: { entry: string; line: number; scope: string; confidence: number } | null;
}

export function buildQueryJSON(
  result: QueryResult,
  expander: ContextExpander,
  flows: Array<{ name: string; steps: string[] }>,
  warnings: Array<{ rule_id: string; node_id: string; detail: string }>
): QueryJSON {
  const ranked = expander.rankWithBoost(expander.expand(result.nodes, 2), result.query);
  const top = ranked[0] ?? null;
  return {
    query: result.query,
    timestamp: result.timestamp,
    nodes: ranked,
    flows,
    warnings,
    ctx: top
      ? {
          entry: top.file,
          line: top.line,
          scope: top.module,
          confidence: parseFloat(calcConfidence(top, result.query).toFixed(2)),
        }
      : null,
  };
}

