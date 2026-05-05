import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { NCNode } from './storage.js';

// Lazy-load tree-sitter to allow graceful fallback
let TreeSitterParser: any;
let tsLanguage: any;
let jsLanguage: any;
let pyLanguage: any;
let treeSitterAvailable = false;

function loadTreeSitter(): void {
  if (treeSitterAvailable !== false) return;
  try {
    TreeSitterParser = require('tree-sitter');
    treeSitterAvailable = true;
  } catch {
    treeSitterAvailable = false;
    return;
  }
  try { const m = require('tree-sitter-typescript'); tsLanguage = m.typescript ?? m; } catch {}
  try { jsLanguage = require('tree-sitter-javascript'); } catch {}
  try { pyLanguage = require('tree-sitter-python'); } catch {}
}

// Effect pattern → label pairs scanned against node text
const EFFECT_PATTERNS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(|\baxios\b|\bhttp\.request\b|\brequests\.(get|post|put|delete|patch)\b|\burllib\b/, 'http'],
  [/\.query\s*\(|\bprisma\b|\bmongoose\b|\bsequelize\b|\bknex\b|\.(findOne|findMany|findAll|create|update|upsert|save|delete)\s*\(|\bexecute\s*\(/, 'db'],
  [/\bfs\.(read|write|append|unlink|mkdir|readdir|stat|exists)|\breadFileSync\b|\bwriteFileSync\b|\bopen\s*\(.*['"](?:r|w|a)/, 'fs'],
  [/\bconsole\.(log|error|warn|info|debug)\b/, 'log'],
  [/\bprocess\.exit\b/, 'process'],
  [/\.emit\s*\(|\bEventEmitter\b/, 'event'],
  [/\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b/, 'timer'],
];

function detectEffects(text: string): string[] {
  const effects: string[] = [];
  for (const [pattern, label] of EFFECT_PATTERNS) {
    if (pattern.test(text)) effects.push(label);
  }
  return effects;
}

const BRANCH_TYPES_TS = new Set([
  'if_statement', 'else_clause', 'ternary_expression',
  'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
  'switch_case', 'catch_clause',
  '&&', '||', '??',
]);

const BRANCH_TYPES_PY = new Set([
  'if_statement', 'elif_clause', 'else_clause',
  'for_statement', 'while_statement',
  'except_clause', 'with_statement',
  'boolean_operator', 'conditional_expression',
]);

interface RawNode {
  type: string;
  name: string;
  inputs: string[];
  outputs: string[];
  deps: string[];
  effects: string[];
  line: number;
  complexity: number;
}

/**
 * Compute a stable per-node content hash from extracted structural data.
 * Avoids the file-level hash, so only truly changed nodes get re-indexed.
 */
function hashNodeContent(r: RawNode): string {
  const key = [
    r.type, r.name, r.line, r.complexity,
    r.inputs.join(','), r.outputs.join(','),
    r.deps.join(','), r.effects.join(','),
  ].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export class NCAParser {
  private parsers: Map<string, any> = new Map();

  constructor() {
    loadTreeSitter();
    if (!treeSitterAvailable) return;

    if (tsLanguage) {
      const p = new TreeSitterParser();
      p.setLanguage(tsLanguage);
      this.parsers.set('ts', p);
      this.parsers.set('tsx', p);
    }
    if (jsLanguage) {
      const p = new TreeSitterParser();
      p.setLanguage(jsLanguage);
      this.parsers.set('js', p);
      this.parsers.set('jsx', p);
      this.parsers.set('mjs', p);
      this.parsers.set('cjs', p);
    }
    if (pyLanguage) {
      const p = new TreeSitterParser();
      p.setLanguage(pyLanguage);
      this.parsers.set('py', p);
    }
  }

  parseFile(filePath: string, sha256: string, rootPath: string): NCNode[] {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');
    const module = fileToModule(filePath, rootPath);

    let raws: RawNode[] = [];

    const parser = this.parsers.get(ext);
    if (parser) {
      try {
        const tree = parser.parse(content);
        raws = ext === 'py'
          ? this.extractPython(tree.rootNode, content)
          : this.extractTS(tree.rootNode, content);
      } catch {
        raws = this.regexFallback(content, ext);
      }
    } else {
      raws = this.regexFallback(content, ext);
    }

    return raws.map(r => ({
      type: r.type,
      name: r.name,
      module,
      inputs: r.inputs,
      outputs: r.outputs,
      deps: r.deps,
      effects: r.effects,
      complexity: r.complexity,
      file: filePath,
      line: r.line,
      sha256: hashNodeContent(r),
    }));
  }

  private extractTS(rootNode: any, _src: string): RawNode[] {
    const results: RawNode[] = [];
    const imports: string[] = [];

    // Collect imports first
    const importNodes = rootNode.descendantsOfType([
      'import_statement', 'import_declaration',
    ]);
    for (const n of importNodes) {
      const src = n.childForFieldName?.('source') ?? findChildOfType(n, 'string');
      if (src) {
        const raw = src.text.replace(/['"]/g, '');
        imports.push(raw);
      }
    }

    // Functions — single descendantsOfType call, no dead variable
    const fnTypes = [
      'function_declaration', 'function_expression',
      'arrow_function', 'method_definition',
      'class_declaration',
    ];
    const fnNodes: any[] = rootNode.descendantsOfType(fnTypes);

    for (const n of fnNodes) {
      const name = extractName(n);
      if (!name || name === '<anonymous>') continue;

      const params = extractParams(n);
      const retType = extractReturnType(n);
      const cx = calcComplexity(n, BRANCH_TYPES_TS);
      const callDeps = extractCalls(n);
      const effects = detectEffects(n.text ?? '');

      results.push({
        type: nodeKind(n.type),
        name,
        inputs: params,
        outputs: retType ? [retType] : [],
        deps: [...imports, ...callDeps],
        line: n.startPosition?.row ?? 0,
        complexity: cx,
        effects,
      });
    }

    return results;
  }

  private extractPython(rootNode: any, _src: string): RawNode[] {
    const results: RawNode[] = [];
    const imports: string[] = [];

    for (const n of rootNode.descendantsOfType(['import_statement', 'import_from_statement'])) {
      const mod = n.childForFieldName?.('module_name') ?? findChildOfType(n, 'dotted_name');
      if (mod) imports.push(mod.text);
    }

    const pyFnTypes = ['function_definition', 'class_definition'];
    const pyFnNodes: any[] = rootNode.descendantsOfType(pyFnTypes);
    for (const n of pyFnNodes) {
      const nameNode = n.childForFieldName?.('name') ?? findChildOfType(n, 'identifier');
      if (!nameNode) continue;
      const name = nameNode.text;
      const params = extractPyParams(n);
      const retType = extractPyReturnType(n);
      const cx = calcComplexity(n, BRANCH_TYPES_PY);
      const callDeps = extractCalls(n);
      const effects = detectEffects(n.text ?? '');

      results.push({
        type: n.type === 'class_definition' ? 'class' : 'function',
        name,
        inputs: params,
        outputs: retType ? [retType] : [],
        deps: [...imports, ...callDeps],
        line: n.startPosition?.row ?? 0,
        complexity: cx,
        effects,
      });
    }

    return results;
  }

  private regexFallback(content: string, _ext: string): RawNode[] {
    const results: RawNode[] = [];
    const imports: string[] = [];

    const importRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const pyImportRe = /^(?:import|from)\s+([\w.]+)/gm;

    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) imports.push(m[1]);
    while ((m = requireRe.exec(content)) !== null) imports.push(m[1]);
    while ((m = pyImportRe.exec(content)) !== null) imports.push(m[1]);

    const fnPatterns: RegExp[] = [
      // Named function declaration: function foo(...) / async function foo(...)
      /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm,
      // Arrow assigned to variable: const foo = (...) => / const foo = async (...) =>
      // Also handles single-param: const foo = x =>
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?[^)=]*\)?\s*=>/gm,
      // Method in class / object: foo(...) {
      /^\s{2,}(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|&]+\s*)?\{/gm,
      // Class declaration
      /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/gm,
      // Python function: def foo(...)
      /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm,
      // Python class
      /^class\s+(\w+)/gm,
    ];

    for (const re of fnPatterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const name = match[1];
        if (!name || /^(if|for|while|switch|catch|return|import|export|const|let|var|async)$/.test(name)) continue;
        const lineIdx = content.slice(0, match.index).split('\n').length - 1;
        const rawParams = match[2] ?? '';
        const params = rawParams
          .split(',')
          .map(p => p.trim().split(':')[0].replace(/[*/?]/g, '').trim())
          .filter(p => p && p !== 'self' && p !== 'cls');
        const snippet = content.slice(match.index, match.index + 500);
        const isClass = /^(?:export\s+)?(?:abstract\s+)?class\b/.test(match[0].trim()) || /^class\b/.test(match[0].trim());
        results.push({
          type: isClass ? 'class' : 'function',
          name,
          inputs: params,
          outputs: [],
          deps: imports,
          effects: detectEffects(snippet),
          line: lineIdx,
          complexity: 1,
        });
      }
    }

    // Deduplicate by name+line
    const seen = new Set<string>();
    return results.filter(r => {
      const k = `${r.name}:${r.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}

function findChildOfType(node: any, type: string): any {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === type) return c;
  }
  return null;
}

function extractName(node: any): string {
  // arrow_function and function_expression don't have a direct name child —
  // findChildOfType would incorrectly return a parameter identifier (e.g. `x` in `x => x*2`)
  const isAnonymousForm = node.type === 'arrow_function' || node.type === 'function_expression';

  if (!isAnonymousForm) {
    const nameNode = node.childForFieldName?.('name') ?? findChildOfType(node, 'identifier');
    if (nameNode) return nameNode.text;
  } else {
    // function_expression can have an optional name: `const f = function named() {}`
    const nameNode = node.childForFieldName?.('name');
    if (nameNode) return nameNode.text;
  }

  // Walk up parent chain to find the assigned variable name
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'variable_declarator') {
      const id = parent.childForFieldName?.('name') ?? findChildOfType(parent, 'identifier');
      if (id) return id.text;
    }
    if (parent.type === 'assignment_expression') {
      const left = parent.childForFieldName?.('left');
      if (left?.type === 'identifier') return left.text;
      if (left?.type === 'member_expression') {
        return left.childForFieldName?.('property')?.text ?? '<anonymous>';
      }
    }
    if (parent.type === 'pair') {
      const key = parent.childForFieldName?.('key');
      if (key) return key.text;
    }
    if (parent.type === 'method_definition') {
      const key = parent.childForFieldName?.('name');
      if (key) return key.text;
    }
    // Stop walking if we hit a block or function boundary
    if (
      parent.type === 'statement_block' ||
      parent.type === 'program' ||
      parent.type === 'function_declaration'
    ) break;
    parent = parent.parent;
  }

  return '<anonymous>';
}

function extractParams(node: any): string[] {
  const paramNode = node.childForFieldName?.('parameters') ?? findChildOfType(node, 'formal_parameters');
  if (!paramNode) return [];
  const params: string[] = [];
  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const p = paramNode.namedChild(i);
    if (!p) continue;
    const name = p.childForFieldName?.('pattern') ?? p.childForFieldName?.('name') ?? findChildOfType(p, 'identifier') ?? p;
    const type = p.childForFieldName?.('type');
    const annotation = type ? `:${type.text.trim()}` : '';
    params.push(`${name.text}${annotation}`);
  }
  return params;
}

function extractPyParams(node: any): string[] {
  const paramNode = node.childForFieldName?.('parameters');
  if (!paramNode) return [];
  const params: string[] = [];
  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const p = paramNode.namedChild(i);
    if (!p || p.text === 'self') continue;
    params.push(p.text);
  }
  return params;
}

function extractReturnType(node: any): string | null {
  const ret = node.childForFieldName?.('return_type');
  if (ret) return ret.text.replace(/^:\s*/, '').trim();
  return null;
}

function extractPyReturnType(node: any): string | null {
  // tree-sitter-python exposes `->` return annotation as 'return_type' field
  const ret = node.childForFieldName?.('return_type');
  if (ret) return ret.text.replace(/^->\s*/, '').trim();
  return null;
}

function extractCalls(node: any): string[] {
  const calls: string[] = [];
  const callNodes = node.descendantsOfType?.(['call_expression', 'call']) ?? [];
  for (const c of callNodes) {
    const fn = c.childForFieldName?.('function') ?? c.child(0);
    if (fn) {
      const name = fn.type === 'member_expression'
        ? fn.childForFieldName?.('property')?.text ?? ''
        : fn.text;
      if (name && /^\w+$/.test(name) && name !== node.childForFieldName?.('name')?.text) {
        calls.push(name);
      }
    }
  }
  return [...new Set(calls)];
}

function calcComplexity(node: any, branchTypes: Set<string>): number {
  let cx = 1;
  function walk(n: any): void {
    if (branchTypes.has(n.type)) cx++;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  }
  walk(node);
  return cx;
}

function nodeKind(type: string): string {
  if (type.includes('class')) return 'class';
  if (type.includes('method')) return 'method';
  if (type.includes('arrow')) return 'arrow';
  return 'function';
}

function fileToModule(filePath: string, rootPath: string): string {
  const rel = path.relative(rootPath, filePath);
  return rel.replace(/\.[^.]+$/, '').replace(/\\/g, '/');
}
