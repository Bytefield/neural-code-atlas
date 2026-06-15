import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Storage, type CallerRef } from './storage.js';

export type { CallerRef };

export interface DocRef {
  title: string;
  file: string;
}

export interface SymbolImpact {
  name: string;
  file: string;
  line: number;
  is_new: boolean;
  callers: CallerRef[];
  docs_linked: DocRef[];
  security_flag: boolean;
  silent_fallback: boolean;
}

export type ConfidenceLevel = 'high' | 'medium' | 'degraded' | 'blocked';

export interface ImpactReport {
  symbols: SymbolImpact[];
  gaps: string[];
  timestamp: string;
  confidence: ConfidenceLevel;
  warnings: string[];
  manual_review_required: boolean;
}

export interface ParsedSymbol {
  name: string;
  file: string;
  line: number;
  is_new: boolean;
}

export interface ParsedDiff {
  symbols: ParsedSymbol[];
  executableFilesChanged: string[];
}

// Matches module-level symbol declarations on added lines (+).
// const requires export to avoid matching local variable declarations.
const SYMBOL_RE =
  /^\+\s*(?:(?:export\s+)?(?:(?:async\s+)?function|class|interface|type)|export\s+const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

const SECURITY_KEYWORDS = ['security', 'auth', 'rls', 'tenant', 'webhook', 'worker', 'middleware'];

export class ImpactAnalyzer {
  constructor(
    private readonly storage: Storage,
    private readonly repoRoot: string
  ) {}

  parseGitDiff(diffText: string): ParsedDiff {
    const symbols: ParsedSymbol[] = [];
    const seen = new Set<string>();
    const executableFilesChanged: string[] = [];

    const blocks = diffText.split(/^(?=diff --git )/m);

    for (const block of blocks) {
      if (!block.startsWith('diff --git ')) continue;

      const isNew = /^new file mode/m.test(block);

      const fileMatch = block.match(/^\+\+\+ b\/(.+)$/m);
      if (!fileMatch) continue;
      const file = fileMatch[1].trim();

      if (!/\.(ts|js|tsx|jsx)$/.test(file)) continue;

      executableFilesChanged.push(file);

      let lineNum = 0;
      for (const raw of block.split('\n')) {
        const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (hunkMatch) {
          lineNum = parseInt(hunkMatch[1], 10) - 1;
          continue;
        }

        if (raw.startsWith('+++') || raw.startsWith('---')) continue;

        if (!raw.startsWith('-')) lineNum++;

        if (raw.startsWith('+')) {
          const m = raw.match(SYMBOL_RE);
          if (m) {
            const name = m[1];
            const key = `${file}:${name}`;
            if (!seen.has(key)) {
              seen.add(key);
              symbols.push({ name, file, line: lineNum, is_new: isNew });
            }
          }
        }
      }
    }

    return { symbols, executableFilesChanged };
  }

  getDiffText(diffSpec: string, repoPath: string): string {
    const gitArgs = diffSpec
      ? diffSpec.includes('..')
        ? ['diff', diffSpec]
        : ['diff', `${diffSpec}~1`, diffSpec]
      : ['diff', 'HEAD'];

    const result = spawnSync('git', gitArgs, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    return result.status === 0 ? (result.stdout as string) : '';
  }

  getTaskLabel(diffSpec: string, repoPath: string): string {
    if (!diffSpec) return 'uncommitted changes';

    const ref = diffSpec.includes('..')
      ? (diffSpec.split('..').pop() ?? 'HEAD')
      : diffSpec;

    const result = spawnSync('git', ['log', '--format=%s', '-1', ref], {
      cwd: repoPath,
      encoding: 'utf-8',
    });

    return result.status === 0
      ? (result.stdout as string).trim()
      : diffSpec;
  }

  analyze(diff: ParsedDiff, diffText: string = ''): ImpactReport {
    const gaps: string[] = [];
    const symbols: SymbolImpact[] = [];

    for (const sym of diff.symbols) {
      const callers = this.storage.getCallersOf(sym.name);

      const docMatches = this.storage.getDocsBySymbol(sym.name);
      const docs_linked: DocRef[] = docMatches.map(d => ({
        title: d.title,
        file: d.file,
      }));

      const security_flag = docs_linked.some(
        d => d.file.includes('/security/') || d.file.toLowerCase().includes('security')
      );

      const silent_fallback = this.checkSilentFallback(sym.file);

      if (callers.length === 0 && !sym.is_new) {
        gaps.push(
          `${sym.name}: no callers found via index — may be a public API or index needs rescan`
        );
      }

      if (docs_linked.length === 0) {
        gaps.push(`${sym.name}: no doc-code edges — not referenced in indexed notes`);
      }

      symbols.push({
        name: sym.name,
        file: sym.file,
        line: sym.line,
        is_new: sym.is_new,
        callers,
        docs_linked,
        security_flag,
        silent_fallback,
      });
    }

    const { confidence, warnings, manual_review_required } = this.computeConfidence(
      diffText,
      diff,
      gaps
    );

    return { symbols, gaps, timestamp: new Date().toISOString(), confidence, warnings, manual_review_required };
  }

  private extractAllChangedPaths(diffText: string): string[] {
    const paths = new Set<string>();
    for (const m of diffText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
      paths.add(m[1].trim());
      paths.add(m[2].trim());
    }
    for (const m of diffText.matchAll(/^--- a\/(.+)$/gm)) {
      const p = m[1].trim();
      if (p !== '/dev/null') paths.add(p);
    }
    for (const m of diffText.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      const p = m[1].trim();
      if (p !== '/dev/null') paths.add(p);
    }
    return [...paths];
  }

  private hasSecurityPath(paths: string[]): boolean {
    return paths.some(p => {
      const parts = p.toLowerCase().split(/[/._-]/);
      return parts.some(part => SECURITY_KEYWORDS.some(kw => part.includes(kw)));
    });
  }

  private computeConfidence(
    diffText: string,
    diff: ParsedDiff,
    gaps: string[]
  ): { confidence: ConfidenceLevel; warnings: string[]; manual_review_required: boolean } {
    const warnings: string[] = [];
    let manual_review_required = false;
    let confidence: ConfidenceLevel = 'high';

    const allPaths = this.extractAllChangedPaths(diffText);

    if (this.hasSecurityPath(allPaths)) {
      warnings.push('Security-sensitive paths changed. Manual review required.');
      manual_review_required = true;
      confidence = 'blocked';
    }

    if (allPaths.some(p => /\.sql$/i.test(p) || /\/migrations\//i.test(p))) {
      warnings.push('SQL or migration files changed and are not analyzed by nca impact.');
      manual_review_required = true;
      confidence = 'blocked';
    }

    if (confidence === 'blocked') {
      return { confidence, warnings, manual_review_required };
    }

    const execCount = diff.executableFilesChanged?.length ?? 0;

    if (execCount > 0 && diff.symbols.length === 0) {
      warnings.push(
        'Executable files changed but no symbol declarations were detected. This may be a body-only change.'
      );
      return { confidence: 'degraded', warnings, manual_review_required };
    }

    if (execCount === 0 && diff.symbols.length === 0) {
      return { confidence: 'high', warnings, manual_review_required };
    }

    confidence = gaps.length > 0 ? 'medium' : 'high';
    return { confidence, warnings, manual_review_required };
  }

  // File-level heuristic: any function in a file that has both a catch block
  // and a silent return (undefined/null/[]/{}/) is flagged.
  private checkSilentFallback(relFile: string): boolean {
    const absPath = path.isAbsolute(relFile)
      ? relFile
      : path.resolve(this.repoRoot, relFile);
    try {
      const src = fs.readFileSync(absPath, 'utf-8');
      return /\bcatch\b/.test(src) && /\breturn\s+(?:undefined|null|\[\]|\{\})/.test(src);
    } catch {
      return false;
    }
  }
}

// ─── output formatters ────────────────────────────────────────────────────────

export function formatText(report: ImpactReport, diffSpec: string): string {
  const lines: string[] = [];
  lines.push(`## nca impact — ${diffSpec || 'HEAD (unstaged)'}`);
  lines.push(`Generated: ${report.timestamp}`);
  lines.push('');

  lines.push(`## Confidence: ${report.confidence.toUpperCase()}`);
  if (report.manual_review_required) {
    lines.push('⚠ Manual review required before merging.');
  }
  if (report.warnings.length > 0) {
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
  }
  lines.push('');

  if (report.symbols.length === 0) {
    lines.push('No TypeScript/JavaScript symbols found in diff.');
    return lines.join('\n');
  }

  for (const sym of report.symbols) {
    lines.push(`### ${sym.name}${sym.is_new ? ' (NEW)' : ''}`);
    lines.push(`- File: \`${sym.file}:${sym.line}\``);

    if (sym.callers.length === 0) {
      lines.push(`- Callers: ${sym.is_new ? 'none (new symbol)' : 'none found in index'}`);
    } else {
      lines.push(`- Callers (${sym.callers.length}):`);
      for (const c of sym.callers) {
        lines.push(`  - \`${c.name}\` at \`${c.file}:${c.line}\``);
      }
    }

    if (sym.docs_linked.length === 0) {
      lines.push('- Docs linked: none');
    } else {
      lines.push(`- Docs linked (${sym.docs_linked.length}):`);
      for (const d of sym.docs_linked) {
        lines.push(`  - ${d.title} (\`${d.file}\`)`);
      }
    }

    lines.push(`- Security flag: ${sym.security_flag}`);
    lines.push(`- Silent fallback: ${sym.silent_fallback}`);
    lines.push('');
  }

  if (report.gaps.length > 0) {
    lines.push('## Gaps of NCA');
    for (const g of report.gaps) {
      lines.push(`- ${g}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatJSON(report: ImpactReport): string {
  return JSON.stringify(
    {
      confidence: report.confidence,
      warnings: report.warnings,
      manual_review_required: report.manual_review_required,
      symbols: report.symbols,
      gaps: report.gaps,
      timestamp: report.timestamp,
    },
    null,
    2
  );
}

export function formatAIR(report: ImpactReport, taskLabel: string): string {
  const callers_affected = report.symbols.map(sym => ({
    symbol: sym.name,
    file: sym.file,
    line: sym.line,
    is_new: sym.is_new,
    callers: sym.callers,
  }));

  const security_symbols = report.symbols
    .filter(s => s.security_flag)
    .map(s => s.name);

  const docs_linked = report.symbols.flatMap(s =>
    s.docs_linked.map(d => ({ symbol: s.name, ...d }))
  );

  const air = {
    air_version: '0.0.1',
    agent_trace_ref: null,
    _note_agent_trace_ref: 'no agent-trace emitted for this session',
    task: taskLabel,
    brief: null,
    _note_brief: 'session predates brief injection',
    confidence: report.confidence,
    warnings: report.warnings,
    manual_review_required: report.manual_review_required,
    impact: { callers_affected, security_symbols, docs_linked },
    approval: { required: true, approved: null, reason: null },
    timestamp: report.timestamp,
  };

  return JSON.stringify(air, null, 2);
}
