#!/usr/bin/env node
/**
 * Sizes the .tsx grammar defect PR #60 confirmed (src/parser.ts:239 parses
 * .tsx files with tree-sitter-typescript's plain 'typescript' grammar, never
 * loading its separate 'tsx' grammar — reproduced exactly against the
 * September index's own node set for one file, ActivateCompanyWizard.tsx).
 * This measures blast radius across all of synio at e29cb7a1. Measurement
 * only — no fix, no re-scan, no index write.
 *
 * EVIDENCE RULE: every file read is `git show e29cb7a1:<path>` (a git
 * object), never the synio working tree. Eligibility uses the REAL scanner
 * rule, read from src/scanner.ts (not .ncaignore, which src/scanner.ts does
 * not reference at all — DEFAULT_EXCLUDED_DIRS / DEFAULT_EXTS / dot-dir skip
 * / max_file_size_kb from collectFiles(), read-only, reproduced here).
 *
 * Node extraction reproduces src/parser.ts's TypeScriptExtractor logic
 * (getNodeKind + extractNodeName) verbatim, read-only — src/ is never
 * imported, executed as part of a scan, or modified.
 *
 * Usage: node test/replay/tsx-grammar-sizing.js
 * Writes test/replay/tsx-grammar-sizing.json and .md.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const Parser = require('tree-sitter');
const TS = require('tree-sitter-typescript');

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');
const SYNIO_ROOT = '/mnt/c/dev/synio';
const COMMIT = 'e29cb7a1';

// ─── Task 1: confirm both grammars are available ──────────────────────────────

function checkGrammarAvailability() {
  const pkg = JSON.parse(fs.readFileSync(require.resolve('tree-sitter-typescript/package.json'), 'utf-8'));
  const hasTypescript = !!TS.typescript;
  const hasTsx = !!TS.tsx;
  return { package: 'tree-sitter-typescript', version: pkg.version, exports: Object.keys(TS), hasTypescript, hasTsx };
}

// ─── Task 2: scanner eligibility rule, read from src/scanner.ts (not .ncaignore) ──

// Verbatim from src/scanner.ts (read-only reproduction, not imported/executed).
const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'coverage', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.nca', 'vendor', '.venv', 'venv', 'env',
]);
const DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const MAX_FILE_SIZE_BYTES = 512 * 1024; // no .nca/config.json existed at e29cb7a1 (confirmed), so the default applies

function isEligiblePath(relPath) {
  const parts = relPath.split('/');
  const fileName = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  for (const d of dirParts) {
    if (d.startsWith('.') || DEFAULT_EXCLUDED_DIRS.has(d)) return false;
  }
  const ext = path.extname(fileName).toLowerCase();
  return DEFAULT_EXTS.has(ext);
}

function listEligibleFiles(ext) {
  const out = execFileSync('git', ['-C', SYNIO_ROOT, 'ls-tree', '-r', '-l', COMMIT], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 50 });
  const rows = out.trim().split('\n').filter(Boolean).map(l => {
    // format: <mode> <type> <sha>\t<size>\t<path>  (ls-tree -l uses tab before path, spaces elsewhere)
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    return m ? { mode: m[1], type: m[2], sha: m[3], size: m[4] === '-' ? null : Number(m[4]), path: m[5] } : null;
  }).filter(Boolean);
  return rows
    .filter(r => r.type === 'blob' && r.path.toLowerCase().endsWith(ext))
    .filter(r => isEligiblePath(r.path))
    .filter(r => r.size !== null && r.size <= MAX_FILE_SIZE_BYTES);
}

// ─── src/parser.ts logic, reproduced verbatim for inspection ─────────────────

function findChildOfType(node, type) {
  for (let i = 0; i < node.childCount; i++) { const c = node.child(i); if (c && c.type === type) return c; }
  return null;
}
function getNodeKind(tsType) {
  if (tsType.includes('class')) return 'class';
  if (tsType.includes('method')) return 'method';
  if (tsType.includes('arrow')) return 'arrow';
  return 'function';
}
function extractNodeName(node) {
  const isAnonymousForm = node.type === 'arrow_function' || node.type === 'function_expression';
  if (!isAnonymousForm) {
    const nameNode = node.childForFieldName?.('name') ?? findChildOfType(node, 'identifier');
    if (nameNode) return nameNode.text;
  } else {
    const nameNode = node.childForFieldName?.('name');
    if (nameNode) return nameNode.text;
  }
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'variable_declarator') { const id = parent.childForFieldName?.('name') ?? findChildOfType(parent, 'identifier'); if (id) return id.text; }
    if (parent.type === 'assignment_expression') { const left = parent.childForFieldName?.('left'); if (left?.type === 'identifier') return left.text; if (left?.type === 'member_expression') return left.childForFieldName?.('property')?.text ?? '<anonymous>'; }
    if (parent.type === 'pair') { const key = parent.childForFieldName?.('key'); if (key) return key.text; }
    if (parent.type === 'method_definition') { const key = parent.childForFieldName?.('name'); if (key) return key.text; }
    if (parent.type === 'statement_block' || parent.type === 'program' || parent.type === 'function_declaration') break;
    parent = parent.parent;
  }
  return '<anonymous>';
}
const FUNCTION_TYPES = ['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'class_declaration'];
function findAllOfType(node, types, out = []) {
  if (types.includes(node.type)) out.push(node);
  for (let i = 0; i < node.childCount; i++) findAllOfType(node.child(i), types, out);
  return out;
}
function countErrorNodes(node, n = { count: 0 }) {
  if (node.type === 'ERROR') n.count++;
  for (let i = 0; i < node.childCount; i++) countErrorNodes(node.child(i), n);
  return n.count;
}

const parserTypescript = new Parser(); parserTypescript.setLanguage(TS.typescript);
const parserTsx = new Parser(); parserTsx.setLanguage(TS.tsx);

// Some files fail to parse at all under this tree-sitter binding (observed:
// content with astral-plane / surrogate-pair characters, e.g. emoji, throws
// a native "Invalid argument" from Parser.parse — a tooling limitation of
// this native binding, not something to work around by altering the input;
// the SAME binding is what src/parser.ts itself calls, so this would also
// affect a real scan of such a file, wrapped there in parseFile's try/catch
// -> regexFallback. Reported as its own bucket here, not silently dropped
// or crashed on.
function analyzeWithGrammar(code, parser) {
  let tree;
  try {
    tree = parser.parse(code);
  } catch (err) {
    return { parseThrew: true, parseError: err.message, hasError: true, errorCount: null, namedNodeCount: 0, byType: { function: 0, arrow: 0, method: 0, class: 0 }, named: [] };
  }
  const errorCount = countErrorNodes(tree.rootNode);
  const fnNodes = findAllOfType(tree.rootNode, FUNCTION_TYPES);
  const named = [];
  const byType = { function: 0, arrow: 0, method: 0, class: 0 };
  for (const n of fnNodes) {
    const name = extractNodeName(n);
    if (name && name !== '<anonymous>') {
      const kind = getNodeKind(n.type);
      named.push({ name, kind, line: n.startPosition.row });
      byType[kind]++;
    }
  }
  return { hasError: tree.rootNode.hasError, errorCount, namedNodeCount: named.length, byType, named };
}

// ─── September index (read-only scratch copy) ─────────────────────────────────

function openSeptDbReadOnly() {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8'));
  const frozenPath = manifest.index.storage.path.replace(/^~/, os.homedir());
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-tsx-sizing-'));
  const copyPath = path.join(workDir, 'sept.db');
  fs.copyFileSync(frozenPath, copyPath);
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(copyPath)).digest('hex');
  if (actualSha !== manifest.index.storage.sha256) throw new Error(`September index sha256 mismatch: expected ${manifest.index.storage.sha256}, got ${actualSha}`);
  return { db: new Database(copyPath, { readonly: true }), cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }) };
}

// ─── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const grammarCheck = checkGrammarAvailability();
  if (!grammarCheck.hasTypescript || !grammarCheck.hasTsx) {
    console.error('FATAL: tree-sitter-typescript does not expose both grammars — cannot size the defect.', grammarCheck);
    process.exit(2);
  }

  // ── Task 2+3: all eligible .tsx files, both grammars ──
  const tsxFiles = listEligibleFiles('.tsx');
  const { db: septDb, cleanup } = openSeptDbReadOnly();

  const perFileResults = [];
  const parseFailureFiles = [];
  for (const f of tsxFiles) {
    const code = execFileSync('git', ['-C', SYNIO_ROOT, 'show', `${COMMIT}:${f.path}`], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 });
    const plain = analyzeWithGrammar(code, parserTypescript);
    const tsx = analyzeWithGrammar(code, parserTsx);

    if (plain.parseThrew || tsx.parseThrew) {
      // Native tree-sitter binding parse failure (observed cause: astral-plane
      // / surrogate-pair characters, e.g. emoji — a tooling limitation, not
      // the .tsx-grammar-selection bug). src/parser.ts:279 wraps its own
      // tree-sitter call in try/catch -> regexFallback for exactly this case,
      // so production does NOT crash on these files either — but the
      // grammar-delta comparison below doesn't apply to them (production
      // never reaches the "which grammar" question, it falls to regex
      // extraction instead, which we do not reproduce here). Excluded from
      // the main aggregate, reported separately.
      parseFailureFiles.push({ path: f.path, sizeBytes: f.size, plainThrew: plain.parseThrew, plainError: plain.parseError, tsxThrew: tsx.parseThrew, tsxError: tsx.parseError });
      continue;
    }

    const septRows = septDb.prepare('SELECT id, type, name, line FROM nodes WHERE file = ?').all(`${SYNIO_ROOT}/${f.path}`);
    // Cross-check (task 5): DB node set should match the plain-grammar reproduction exactly.
    const plainSet = new Set(plain.named.map(n => `${n.name}|${n.kind}|${n.line}`));
    const septSet = new Set(septRows.map(n => `${n.name}|${n.type}|${n.line}`));
    const dbMatchesPlainGrammar = plainSet.size === septSet.size && [...plainSet].every(x => septSet.has(x));

    perFileResults.push({
      path: f.path,
      sizeBytes: f.size,
      plain: { hasError: plain.hasError, errorCount: plain.errorCount, namedNodeCount: plain.namedNodeCount, byType: plain.byType },
      tsx: { hasError: tsx.hasError, errorCount: tsx.errorCount, namedNodeCount: tsx.namedNodeCount, byType: tsx.byType },
      lostNodeCount: tsx.namedNodeCount - plain.namedNodeCount,
      lostPct: tsx.namedNodeCount > 0 ? Math.round(((tsx.namedNodeCount - plain.namedNodeCount) / tsx.namedNodeCount) * 1000) / 10 : 0,
      sept_db_node_count: septRows.length,
      db_matches_plain_grammar_reproduction: dbMatchesPlainGrammar,
    });
  }

  // ── Task 4: control on .ts files (sample or all — all, since it's cheap) ──
  const tsFiles = listEligibleFiles('.ts');
  const tsSampleSize = Math.min(tsFiles.length, 60); // deterministic: every Nth file for an even spread
  const step = Math.max(1, Math.floor(tsFiles.length / tsSampleSize));
  const tsSample = tsFiles.filter((_, i) => i % step === 0).slice(0, tsSampleSize);

  const tsControlResults = [];
  const tsControlParseFailures = [];
  for (const f of tsSample) {
    const code = execFileSync('git', ['-C', SYNIO_ROOT, 'show', `${COMMIT}:${f.path}`], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 });
    const plain = analyzeWithGrammar(code, parserTypescript);
    const tsx = analyzeWithGrammar(code, parserTsx);
    if (plain.parseThrew || tsx.parseThrew) {
      tsControlParseFailures.push({ path: f.path, plainThrew: plain.parseThrew, tsxThrew: tsx.parseThrew });
      continue;
    }
    tsControlResults.push({ path: f.path, plainNamed: plain.namedNodeCount, tsxGrammarNamed: tsx.namedNodeCount, plainErrors: plain.errorCount, tsxGrammarErrors: tsx.errorCount, delta: tsx.namedNodeCount - plain.namedNodeCount });
  }
  const tsControlTotalDelta = tsControlResults.reduce((s, r) => s + r.delta, 0);
  const tsControlDiscrepancies = tsControlResults.filter(r => r.delta !== 0);

  septDb.close();
  cleanup();

  // ── Task 6: aggregates ──
  const totalPlainNodes = perFileResults.reduce((s, r) => s + r.plain.namedNodeCount, 0);
  const totalTsxGrammarNodes = perFileResults.reduce((s, r) => s + r.tsx.namedNodeCount, 0);
  const totalLost = totalTsxGrammarNodes - totalPlainNodes;
  const totalLostPct = totalTsxGrammarNodes > 0 ? Math.round((totalLost / totalTsxGrammarNodes) * 1000) / 10 : 0;

  const byTypeLost = { function: 0, arrow: 0, method: 0, class: 0 };
  for (const key of Object.keys(byTypeLost)) {
    const plainSum = perFileResults.reduce((s, r) => s + r.plain.byType[key], 0);
    const tsxSum = perFileResults.reduce((s, r) => s + r.tsx.byType[key], 0);
    byTypeLost[key] = tsxSum - plainSum;
  }

  const lostPcts = perFileResults.map(r => r.lostPct).sort((a, b) => a - b);
  const distribution = {
    zero_loss: perFileResults.filter(r => r.lostPct === 0).length,
    under_25pct: perFileResults.filter(r => r.lostPct > 0 && r.lostPct < 25).length,
    between_25_75pct: perFileResults.filter(r => r.lostPct >= 25 && r.lostPct <= 75).length,
    over_75pct: perFileResults.filter(r => r.lostPct > 75).length,
    p50_pct_lost: percentile(lostPcts, 50),
    p90_pct_lost: percentile(lostPcts, 90),
  };
  const zeroSurvivorFiles = perFileResults.filter(r => r.plain.namedNodeCount === 0 && r.tsx.namedNodeCount > 0);

  const dbCrossCheckDiscrepancies = perFileResults.filter(r => !r.db_matches_plain_grammar_reproduction);

  // ── Task 7: replay queries that targeted a .tsx ──
  const recallDiagnosis = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'recall-diagnosis.json'), 'utf-8'));
  const reportDrift = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'report-drift.json'), 'utf-8'));
  const tsxTargetedQueries = [];
  for (const r of reportDrift.results) {
    if (r.out_of_scope_project) continue;
    let targetsTsx = false;
    let evidence = null;
    if (r.cls === 'direct_hit') {
      // direct_hit detail embeds file paths like f:/mnt/c/dev/synio/....tsx:LINE
      const m = (r.query ? '' : ''); // no-op, direct_hit detail not stored in report-drift.json results; check recall-diagnosis for matcher rows instead
    }
    if (r.drift && r.drift.candidates) {
      for (const c of r.drift.candidates) {
        if (c.exists && c.evidence && /\.tsx:/.test(c.evidence)) { targetsTsx = true; evidence = c.evidence; }
      }
    }
    if (targetsTsx) tsxTargetedQueries.push({ event_id: r.event_id, query: r.query, cls: r.cls, evidence });
  }
  // Also check NODE_PRESENT_MATCHER_MISSED / direct_hit rows via recall-diagnosis.json (has sept_matches with file paths)
  for (const r of recallDiagnosis.results) {
    if (r.class !== 'NODE_PRESENT_MATCHER_MISSED') continue;
    const tsxMatches = (r.sept_matches || []).flatMap(sm => sm.nodes || []).filter(n => n.file && n.file.endsWith('.tsx'));
    if (tsxMatches.length > 0 && !tsxTargetedQueries.some(q => q.event_id === r.event_id)) {
      tsxTargetedQueries.push({ event_id: r.event_id, query: r.query, cls: r.class, evidence: `sept node file: ${tsxMatches[0].file}` });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    commit: COMMIT,
    grammar_availability: grammarCheck,
    scanner_eligibility_rule: {
      source: 'src/scanner.ts (read-only) — NOT .ncaignore, which src/scanner.ts does not reference at all.',
      DEFAULT_EXCLUDED_DIRS: [...DEFAULT_EXCLUDED_DIRS],
      DEFAULT_EXTS: [...DEFAULT_EXTS],
      max_file_size_kb_default: 512,
      config_json_at_commit: 'none — .nca/config.json did not exist at e29cb7a1, defaults apply unmodified.',
    },
    tsx_files: {
      total_eligible: tsxFiles.length,
      total_measured_in_grammar_delta: perFileResults.length,
      parse_failures: {
        purpose: "Native tree-sitter binding throws on some file content (observed cause: astral-plane/surrogate-pair characters, e.g. emoji) under EITHER grammar — a tooling limitation, not the .tsx grammar-selection bug. src/parser.ts:279 already wraps its own parse call in try/catch -> regexFallback, so production does not crash on these either, but the grammar-delta comparison below does not apply to them (production never reaches the 'which grammar' question for these files). Excluded from the aggregate below, listed here.",
        count: parseFailureFiles.length,
        files: parseFailureFiles,
      },
      aggregate: {
        total_named_nodes_plain_grammar_actual: totalPlainNodes,
        total_named_nodes_tsx_grammar_correct: totalTsxGrammarNodes,
        delta_absolute: totalLost,
        delta_pct: totalLostPct,
        delta_by_node_type: byTypeLost,
      },
      distribution,
      zero_survivor_files: zeroSurvivorFiles.map(r => ({ path: r.path, tsx_grammar_nodes: r.tsx.namedNodeCount })),
      db_cross_check: {
        purpose: "For each .tsx file, does the September index's actual node set for that file match this reproduction's plain-grammar node set exactly (name+type+line)? Confirms #60's single-file finding generalizes.",
        total_files_checked: perFileResults.length,
        discrepancies_count: dbCrossCheckDiscrepancies.length,
        discrepancies: dbCrossCheckDiscrepancies.map(r => ({ path: r.path, sept_db_node_count: r.sept_db_node_count, plain_grammar_node_count: r.plain.namedNodeCount })),
      },
      per_file: perFileResults,
    },
    ts_control: {
      purpose: 'Same measurement on a sample of .ts files — expected delta 0 (grammar choice should not matter without JSX).',
      sample_size: tsControlResults.length,
      total_ts_files_eligible: tsFiles.length,
      total_delta: tsControlTotalDelta,
      discrepancies: tsControlDiscrepancies,
      discrepancies_found: tsControlDiscrepancies.length > 0,
    },
    replay_queries_targeting_tsx: {
      purpose: 'Of the 58 in-scope replay queries, how many targeted (matched, or had git-grep-confirmed candidate evidence in) a .tsx file — i.e. the defect already manifested in real usage beyond n=1.',
      count: tsxTargetedQueries.length,
      queries: tsxTargetedQueries,
    },
    proposed_ledger_line_REC_0004: null, // filled below
  };

  report.proposed_ledger_line_REC_0004 =
    `REC-0004 — nca_ask/nca_impact indexer coverage, .tsx grammar mismatch. ` +
    `Evidence: src/parser.ts:239 parses .tsx with tree-sitter-typescript's plain 'typescript' grammar (never loads its 'tsx' grammar, confirmed both present, tree-sitter-typescript@${grammarCheck.version}). ` +
    `Measured across ${perFileResults.length} of ${tsxFiles.length} scan-eligible .tsx files in synio@${COMMIT} (git-object read, DEFAULT_EXTS/DEFAULT_EXCLUDED_DIRS/512KB size rule from src/scanner.ts; ${parseFailureFiles.length} excluded — native tree-sitter parse failures unrelated to the grammar-selection bug, see parse_failures): ` +
    `${totalPlainNodes} named nodes produced vs ${totalTsxGrammarNodes} with the correct .tsx grammar — ${totalLost} nodes lost (${totalLostPct}%), ${zeroSurvivorFiles.length} files with ZERO surviving nodes (fully invisible to nca_ask/nca_impact). ` +
    `Loss distribution: ${distribution.zero_loss} files 0% loss, ${distribution.under_25pct} files <25%, ${distribution.between_25_75pct} files 25-75%, ${distribution.over_75pct} files >75% — ` +
    `${distribution.over_75pct > perFileResults.length * 0.5 ? 'systemic' : 'evaluate concentration vs distribution.count breakdown'}. ` +
    `.ts control (n=${tsControlResults.length}, of ${tsFiles.length} eligible): total delta ${tsControlTotalDelta}, ${tsControlDiscrepancies.length} discrepancies — ${tsControlDiscrepancies.length === 0 ? 'confirms the effect is .tsx/JSX-specific, not a general grammar-choice artifact' : 'UNEXPECTED, see discrepancies list'}. ` +
    `September DB cross-check: ${dbCrossCheckDiscrepancies.length === 0 ? `all ${perFileResults.length} .tsx files' actual index node sets match this reproduction exactly — #60's single-file finding generalizes without exception` : `${dbCrossCheckDiscrepancies.length} files where the DB does NOT match this reproduction — see discrepancies`}. ` +
    `${tsxTargetedQueries.length} of the 58 in-scope Phase A replay queries targeted a .tsx file (real usage manifestation, not just n=1). ` +
    `evidence_level: HIGH (exact reproduction against frozen index, not inference). candidate_type: FIX_RELIABILITY vs NO_INTERVENTION — numbers only, not decided here. ` +
    `If fixed, re-measure: nodes-per-.tsx-file count (this same script, re-run against a fresh scan) and Replay B (drift/source-text classification) to confirm the .tsx-sourced INDEXABLE_CONSTRUCT_NO_NODE and any downstream MULTI_TOKEN_QUERY/OTHER classifications shift as expected.`;

  fs.writeFileSync(path.join(REPLAY_DIR, 'tsx-grammar-sizing.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // ── Markdown ──
  const lines = [];
  lines.push('# .tsx grammar defect — blast radius sizing at e29cb7a1 (measurement only)');
  lines.push('');
  lines.push(`Evidence rule: every file read via \`git show ${COMMIT}:<path>\` (git object), never the synio working tree.`);
  lines.push('');
  lines.push('## 1. Grammar availability');
  lines.push('');
  lines.push(`\`tree-sitter-typescript@${grammarCheck.version}\` exports: \`${grammarCheck.exports.join(', ')}\` — both \`typescript\` and \`tsx\` present.`);
  lines.push('');
  lines.push('## 2. Scanner eligibility rule (from src/scanner.ts, NOT .ncaignore)');
  lines.push('');
  lines.push(`\`.ncaignore\` is not referenced anywhere in src/ — the real exclusion mechanism is \`DEFAULT_EXCLUDED_DIRS\` + any dot-prefixed directory + \`DEFAULT_EXTS\` + \`max_file_size_kb\` (default 512), all in \`src/scanner.ts:collectFiles()\`. No \`.nca/config.json\` existed at ${COMMIT}, so defaults apply unmodified.`);
  lines.push('');
  lines.push(`Excluded dirs: \`${[...DEFAULT_EXCLUDED_DIRS].join(', ')}\` (+ any dot-prefixed directory)`);
  lines.push('');
  lines.push('## Parse failures (excluded from the aggregate below)');
  lines.push('');
  lines.push(`${parseFailureFiles.length} of ${tsxFiles.length} eligible .tsx files throw a native tree-sitter "Invalid argument" error under one or both grammars (observed cause: astral-plane/surrogate-pair characters such as emoji in the source — a tooling limitation of this binding, not the .tsx grammar-selection bug). \`src/parser.ts:279\` already wraps its own parse call in try/catch -> \`regexFallback\`, so production does not crash on these files either — but the grammar-delta comparison below does not apply to them (production never reaches "which grammar", it falls to a regex-based extractor instead, not reproduced here). Aggregate below is computed over the remaining ${perFileResults.length}.`);
  lines.push('');
  if (parseFailureFiles.length > 0) {
    lines.push('| path | size(B) | plain grammar threw | tsx grammar threw |');
    lines.push('|---|---|---|---|');
    for (const p of parseFailureFiles) lines.push(`| ${p.path} | ${p.sizeBytes} | ${p.plainThrew ? 'yes' : 'no'} | ${p.tsxThrew ? 'yes' : 'no'} |`);
    lines.push('');
  }
  lines.push('## 6. Aggregates');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  lines.push(`| total .tsx eligible | ${tsxFiles.length} |`);
  lines.push(`| total .tsx measured (eligible minus parse failures) | ${perFileResults.length} |`);
  lines.push(`| named nodes, plain grammar (actual) | ${totalPlainNodes} |`);
  lines.push(`| named nodes, tsx grammar (correct) | ${totalTsxGrammarNodes} |`);
  lines.push(`| delta (absolute) | ${totalLost} |`);
  lines.push(`| delta (%) | ${totalLostPct}% |`);
  lines.push('');
  lines.push('### Delta by node type');
  lines.push('');
  lines.push('(tsx-grammar count minus plain-grammar count, summed across all measured files — positive = lost under the current defect, negative = the plain grammar produces MORE of that type in aggregate, e.g. from parse-error recovery producing extra arrow/method-shaped fragments.)');
  lines.push('');
  lines.push('| type | lost |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(byTypeLost)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('### Distribution (concentrated vs systemic)');
  lines.push('');
  lines.push(`p50 % lost per file: ${distribution.p50_pct_lost}% · p90 % lost per file: ${distribution.p90_pct_lost}%`);
  lines.push('');
  lines.push('| bucket | file count |');
  lines.push('|---|---|');
  lines.push(`| 0% loss | ${distribution.zero_loss} |`);
  lines.push(`| <25% loss | ${distribution.under_25pct} |`);
  lines.push(`| 25-75% loss | ${distribution.between_25_75pct} |`);
  lines.push(`| >75% loss | ${distribution.over_75pct} |`);
  lines.push('');
  lines.push(`### Files with 0 surviving nodes (fully invisible to nca_ask/nca_impact): ${zeroSurvivorFiles.length}`);
  lines.push('');
  if (zeroSurvivorFiles.length > 0) {
    lines.push('| path | nodes under correct grammar |');
    lines.push('|---|---|');
    for (const f of zeroSurvivorFiles) lines.push(`| ${f.path} | ${f.tsx.namedNodeCount} |`);
  } else {
    lines.push('None.');
  }
  lines.push('');
  lines.push('## 5. September DB cross-check');
  lines.push('');
  lines.push(`${perFileResults.length} .tsx files checked. Discrepancies (DB node set != plain-grammar reproduction): ${dbCrossCheckDiscrepancies.length}.`);
  lines.push('');
  if (dbCrossCheckDiscrepancies.length > 0) {
    lines.push('| path | sept DB nodes | plain-grammar reproduction nodes |');
    lines.push('|---|---|---|');
    for (const d of dbCrossCheckDiscrepancies) lines.push(`| ${d.path} | ${d.sept_db_node_count} | ${d.plain.namedNodeCount} |`);
  } else {
    lines.push('None — every .tsx file\'s actual September index node set matches this reproduction exactly.');
  }
  lines.push('');
  lines.push('## 4. .ts control');
  lines.push('');
  lines.push(`Sample: ${tsControlResults.length} of ${tsFiles.length} eligible .ts files (deterministic even-spread sample). Total delta (tsx-grammar-nodes minus plain-grammar-nodes, summed): **${tsControlTotalDelta}**.`);
  lines.push('');
  lines.push(tsControlDiscrepancies.length === 0
    ? 'No discrepancies — grammar choice makes no difference on .ts files, as expected (confirms the effect is JSX-specific to .tsx, not a general parsing artifact of this measurement approach).'
    : `${tsControlDiscrepancies.length} discrepancies found — UNEXPECTED, reported as a separate potential defect, not investigated further:`);
  if (tsControlDiscrepancies.length > 0) {
    lines.push('');
    lines.push('| path | plain named | tsx-grammar named | delta |');
    lines.push('|---|---|---|---|');
    for (const d of tsControlDiscrepancies) lines.push(`| ${d.path} | ${d.plainNamed} | ${d.tsxGrammarNamed} | ${d.delta} |`);
  }
  lines.push('');
  lines.push('## 7. Replay queries that targeted a .tsx (context only)');
  lines.push('');
  lines.push(`${tsxTargetedQueries.length} of the 58 in-scope Phase A replay queries targeted a .tsx file.`);
  lines.push('');
  if (tsxTargetedQueries.length > 0) {
    lines.push('| event_id | query | class | evidence |');
    lines.push('|---|---|---|---|');
    for (const q of tsxTargetedQueries) lines.push(`| ${q.event_id} | ${JSON.stringify(q.query)} | ${q.cls} | ${(q.evidence || '').replace(/\|/g, '\\|').slice(0, 120)} |`);
  }
  lines.push('');
  lines.push('## Proposed ledger line for REC-0004 (NOT applied)');
  lines.push('');
  lines.push('```');
  lines.push(report.proposed_ledger_line_REC_0004);
  lines.push('```');
  lines.push('');
  lines.push('## Per-file detail');
  lines.push('');
  lines.push('| path | size(B) | plain named | tsx-grammar named | lost | lost% | sept DB nodes | DB matches reproduction |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of perFileResults) {
    lines.push(`| ${r.path} | ${r.sizeBytes} | ${r.plain.namedNodeCount} | ${r.tsx.namedNodeCount} | ${r.lostNodeCount} | ${r.lostPct}% | ${r.sept_db_node_count} | ${r.db_matches_plain_grammar_reproduction ? 'yes' : 'NO'} |`);
  }
  lines.push('');

  fs.writeFileSync(path.join(REPLAY_DIR, 'tsx-grammar-sizing.md'), lines.join('\n'), 'utf-8');

  console.log(`.tsx eligible: ${tsxFiles.length} | plain nodes: ${totalPlainNodes} | tsx-grammar nodes: ${totalTsxGrammarNodes} | lost: ${totalLost} (${totalLostPct}%)`);
  console.log(`0-survivor files: ${zeroSurvivorFiles.length}`);
  console.log(`.ts control delta: ${tsControlTotalDelta} (${tsControlDiscrepancies.length} discrepancies)`);
  console.log(`DB cross-check discrepancies: ${dbCrossCheckDiscrepancies.length}`);
  console.log(`Replay queries targeting .tsx: ${tsxTargetedQueries.length}`);
  console.log(`Wrote ${path.join(REPLAY_DIR, 'tsx-grammar-sizing.json')} and .md`);
}

main();
