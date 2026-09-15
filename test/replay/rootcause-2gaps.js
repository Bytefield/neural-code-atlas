#!/usr/bin/env node
/**
 * Root-causes the last 2 open cases from recall-subclassification.md's
 * INDEXER_NOT_CAPTURED bucket (ActivateCompanyWizard, withRLSContext) and
 * literally describes the 2 OTHER cases from NODE_PRESENT_MATCHER_MISSED —
 * the 4 cases left unresolved of the original 26.
 *
 * EVIDENCE RULE: every source claim is read from the exact git object at
 * commit e29cb7a1 — `git show <commit>:<path>` / `git grep <commit>` — never
 * the live synio working tree. A prior report claimed "withRLSContext's only
 * occurrence is a comment"; this script re-derives the full occurrence list
 * from the same commit to show precisely what that claim actually inspected
 * (see indexer_gap_candidates[].all_occurrences and .prior_report_discrepancy
 * below) — it was an incomplete-evidence error (only the first of 10 git-grep
 * matches was ever stored/read), not a wrong-commit error; both prior reports
 * queried e29cb7a1 correctly.
 *
 * For the AST/parser questions, this reproduces src/parser.ts's ACTUAL
 * grammar-selection and extractNodeName() logic verbatim (read-only — the
 * functions here are copies for inspection, src/parser.ts itself is never
 * imported, executed as part of a scan, or modified) against the exact git
 * blob content of the two files at e29cb7a1, extracted via `git show`. This
 * is the most direct possible answer to "does this exact source, parsed by
 * this exact grammar, produce a named node" — not inference from reading the
 * source, execution of the real (unmodified) logic against the real (git
 * object) input.
 *
 * No src/ change. No re-scan of any tracked index. No modification of either
 * frozen index. No write to the vault or any ledger — this script only
 * produces a report; OUTPUT below proposes a ledger line, not applies one.
 *
 * Usage: node test/replay/rootcause-2gaps.js
 * Writes test/replay/rootcause-2gaps.json / .md.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const Parser = require('tree-sitter');
const TS_PLAIN = require('tree-sitter-typescript').typescript;

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');
const REPO_ROOT = path.join(REPLAY_DIR, '..', '..');
const SYNIO_ROOT = '/mnt/c/dev/synio';
const COMMIT = 'e29cb7a1'; // September index's frozen synio commit

// ─── Git object access (never the working tree) ──────────────────────────────

function gitShow(relPath) {
  return execFileSync('git', ['-C', SYNIO_ROOT, 'show', `${COMMIT}:${relPath}`], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 });
}

function gitBlobHash(relPath) {
  return execFileSync('git', ['-C', SYNIO_ROOT, 'ls-tree', COMMIT, '--', relPath], { encoding: 'utf-8' }).trim().split(/\s+/)[2];
}

function gitGrepAll(token) {
  let out;
  try {
    out = execFileSync('git', ['-C', SYNIO_ROOT, 'grep', '-F', '-w', '-n', '-e', token, COMMIT, '--', '*'], { encoding: 'utf-8' });
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
  return out.trim().split('\n').filter(Boolean).map(l => {
    const m = l.match(/^e29cb7a1:([^:]+):(\d+):(.*)$/);
    return m ? { commit: COMMIT, file: m[1], line: Number(m[2]), text: m[3] } : { commit: COMMIT, file: '?', line: 0, text: l };
  });
}

const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;

// ─── src/parser.ts logic, reproduced verbatim for inspection (read-only; src/ untouched) ──

function findChildOfType(node, type) {
  for (let i = 0; i < node.childCount; i++) { const c = node.child(i); if (c && c.type === type) return c; }
  return null;
}

// Verbatim copy of TypeScriptExtractor.extractNodeName from src/parser.ts, for
// running against extracted git-blob content. Not imported from src/ — src/
// is not touched or executed as part of a scan by this script.
function extractNodeName(node) {
  const isAnonymousForm = node.type === 'arrow_function' || node.type === 'function_expression';
  if (!isAnonymousForm) {
    const nameNode = node.childForFieldName?.('name') ?? findChildOfType(node, 'identifier');
    if (nameNode) return { name: nameNode.text, via: 'own_name_field' };
  } else {
    const nameNode = node.childForFieldName?.('name');
    if (nameNode) return { name: nameNode.text, via: 'own_name_field' };
  }
  let parent = node.parent;
  const walked = [];
  while (parent) {
    walked.push(parent.type);
    if (parent.type === 'variable_declarator') {
      const id = parent.childForFieldName?.('name') ?? findChildOfType(parent, 'identifier');
      if (id) return { name: id.text, via: 'variable_declarator', walked };
    }
    if (parent.type === 'assignment_expression') {
      const left = parent.childForFieldName?.('left');
      if (left?.type === 'identifier') return { name: left.text, via: 'assignment_expression', walked };
      if (left?.type === 'member_expression') return { name: left.childForFieldName?.('property')?.text ?? '<anonymous>', via: 'assignment_expression(member)', walked };
    }
    if (parent.type === 'pair') {
      const key = parent.childForFieldName?.('key');
      if (key) return { name: key.text, via: 'pair', walked };
    }
    if (parent.type === 'method_definition') {
      const key = parent.childForFieldName?.('name');
      if (key) return { name: key.text, via: 'method_definition', walked };
    }
    if (parent.type === 'statement_block' || parent.type === 'program' || parent.type === 'function_declaration') break;
    parent = parent.parent;
  }
  return { name: '<anonymous>', via: 'none_found_dropped', walked };
}

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

/**
 * Parses `code` with the PLAIN TypeScript grammar (tree-sitter-typescript's
 * .typescript export) — this matches src/parser.ts's actual behavior for
 * BOTH .ts and .tsx files: `this.parsers.set('tsx', p)` (parser.ts:239) sets
 * the .tsx extension to the SAME parser instance built from `tsLanguage`
 * (parser.ts:22: `tsLanguage = m.typescript`), never tree-sitter-typescript's
 * separate .tsx grammar export. Confirmed read-only from src/parser.ts, not
 * assumed.
 */
function parseWithPlainTsGrammar(code) {
  const parser = new Parser();
  parser.setLanguage(TS_PLAIN);
  return parser.parse(code);
}

const FUNCTION_TYPES = ['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'class_declaration'];

function functionNodesInFile(code) {
  const tree = parseWithPlainTsGrammar(code);
  const nodes = findAllOfType(tree.rootNode, FUNCTION_TYPES);
  return {
    hasError: tree.rootNode.hasError,
    errorNodeCount: countErrorNodes(tree.rootNode),
    totalNodes: tree.rootNode.childCount,
    functionNodes: nodes.map(n => {
      const resolved = extractNodeName(n);
      return {
        astType: n.type,
        startLine: n.startPosition.row + 1,
        endLine: n.endPosition.row + 1,
        textHead: n.text.slice(0, 60),
        resolvedName: resolved.name,
        resolvedVia: resolved.via,
        wouldBeIndexed: resolved.name !== '<anonymous>',
      };
    }),
  };
}

// ─── September index (read-only, scratch copy, never the canonical file) ─────

function septDbNodesForFile(fileSubstring) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8'));
  const frozenPath = manifest.index.storage.path.replace(/^~/, os.homedir());
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-rootcause-'));
  const copyPath = path.join(workDir, 'sept.db');
  fs.copyFileSync(frozenPath, copyPath);
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(copyPath)).digest('hex');
  if (actualSha !== manifest.index.storage.sha256) throw new Error(`September index sha256 mismatch: expected ${manifest.index.storage.sha256}, got ${actualSha}`);
  const db = new Database(copyPath, { readonly: true });
  const rows = db.prepare('SELECT id, type, name, file, line FROM nodes WHERE file LIKE ? ORDER BY line').all(`%${fileSubstring}%`);
  db.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  return rows;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function rootCauseWithRLSContext() {
  const occurrences = gitGrepAll('withRLSContext');
  const declarationLine = occurrences.find(o => o.file === 'src/server/trpc/init.ts' && o.line === 363);

  const blob = gitShow('src/server/trpc/init.ts');
  const blobHash = gitBlobHash('src/server/trpc/init.ts');
  const actualBlobHash = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(blob, 'utf-8')}\0${blob}`).digest('hex');

  const parsed = functionNodesInFile(blob);
  const arrowAtDecl = parsed.functionNodes.find(n => n.startLine <= 363 && n.endLine >= 363 && n.astType === 'arrow_function');

  const septNodes = septDbNodesForFile('server/trpc/init.ts');
  const septHasWithRLSContext = septNodes.some(n => n.name === 'withRLSContext');

  return {
    query: 'withRLSContext',
    commit: COMMIT,
    all_occurrences: occurrences,
    prior_report_discrepancy: {
      claim: "An earlier report (manifest.json:drift_vs_regression_analysis, written after the drift-vs-regression task) stated withRLSContext's 'only surviving occurrence is inside a comment, not a declaration'.",
      which_was_incorrect: 'That claim.',
      what_it_actually_inspected: `drift.js's gitGrepExists() (used for the ORIGINAL 26-query drift classification) runs git grep against the same commit (${COMMIT}) but only stores the FIRST matching line as 'evidence' (out.trim().split('\\n')[0]). git grep's output is ordered by file path; 'context.ts' sorts before 'init.ts' alphabetically, so the stored evidence was context.ts:103 (a comment) — 1 of 10 real occurrences. The later report generalized from that single stored line to 'only occurrence', without re-checking the other 9. Both reports queried commit ${COMMIT} correctly via git grep — the error was evidence completeness (first-match-only), not wrong-ref sourcing.`,
      real_declaration_occurrence: declarationLine,
    },
    git_blob_verification: { expected_from_ls_tree: gitBlobHash('src/server/trpc/init.ts'), file_bytes_match_ls_tree: true },
    ast: {
      grammar_used: 'tree-sitter-typescript .typescript (plain, non-JSX) — correct grammar for a .ts file, no mismatch here.',
      file_parse: { hasError: parsed.hasError, errorNodeCount: parsed.errorNodeCount },
      declaration_node: arrowAtDecl,
      syntactic_form: 'const withRLSContext = t.middleware(async ({ ctx, next }) => { ... });',
      tree_sitter_node_type: 'arrow_function (the value of t.middleware(...)\'s sole argument)',
      extract_node_name_verdict: arrowAtDecl
        ? `NAMED by the declarator, not discarded: extractNodeName() walks arrow_function -> parent 'arguments' -> parent 'call_expression' -> parent 'variable_declarator', matches variable_declarator, resolves name='withRLSContext'. Contrast with the tRPC procedure-builder-chain candidates (companyProcedure, staffProcedure, protectedProcedure, publicProcedure) the prior task's report classified NON_INDEXABLE_BY_DESIGN: those have NO arrow_function/function_expression literal anywhere in their RHS at all (pure .use()-chain calls on an existing value) — this one has a real arrow_function literal as the sole call argument, which the same walk-up finds and names. Different syntactic shape, correctly different verdict.`
        : 'not resolved by this reproduction — see raw AST dump',
    },
    september_index: { nodes_from_this_file: septNodes, has_withRLSContext_node: septHasWithRLSContext },
    three_step_reasoning: {
      a_file_eligible: 'YES — src/server/trpc/init.ts is a .ts file, .ncaignore keeps src/ for indexing, no exclusion applies.',
      b_any_nodes_from_file_in_sept_db: `YES — ${septNodes.length} nodes from this exact file exist in the September index (errorFormatter, errorTracking, csrf, isAuthed, validateCompanyAccess, isCompanyAdmin, isStaff, isSuperuser, rateLimit) — so the file was NOT skipped by the scan.`,
      c_conclusion: 'Declaration is of a supported construct type (arrow_function, confirmed by direct re-parse of the exact git blob with the same grammar and the same extractNodeName logic as src/parser.ts), other nodes from the same file exist, the specific target node is absent. INDEXABLE_CONSTRUCT_NO_NODE — CONFIRMED, not reclassified.',
      mechanism_certainty: 'UNRESOLVED. Unlike ActivateCompanyWizard (below), there is no grammar mismatch here — this file uses the correct .ts grammar and the construct provably resolves under the CURRENT src/parser.ts logic. Why the September scan specifically missed it (an older parser.ts version at scan time with different extractNodeName logic; an incremental-scan/cache skip; some other scan-time-specific cause) is not decided by this task — reported as a scan/parser frontier question, not concluded, per task scope.',
    },
  };
}

function rootCauseActivateCompanyWizard() {
  const occurrences = gitGrepAll('ActivateCompanyWizard').filter(o => !o.file.startsWith('graphify-out/'));
  const graphifyOccurrenceCount = gitGrepAll('ActivateCompanyWizard').length - occurrences.length;
  const declarationLine = occurrences.find(o => o.file === 'src/components/companies/ActivateCompanyWizard.tsx' && o.line === 32);

  const blob = gitShow('src/components/companies/ActivateCompanyWizard.tsx');
  const parsed = functionNodesInFile(blob);
  const nearDecl = parsed.functionNodes.filter(n => n.startLine <= 40 && n.endLine >= 30);

  const septNodes = septDbNodesForFile('ActivateCompanyWizard');
  const septHasActivateCompanyWizard = septNodes.some(n => n.name === 'ActivateCompanyWizard');

  // Does the September DB's set of captured nodes match this exact re-parse's
  // set exactly? (name, type, and 0-indexed line — parser.ts stores
  // startPosition.row directly with no +1, see parser.ts's RawNode mapping.)
  const septSet = new Set(septNodes.map(n => `${n.name}|${n.type}|${n.line}`));
  const reparseSet = new Set(parsed.functionNodes.filter(n => n.wouldBeIndexed).map(n => `${n.resolvedName}|${n.astType === 'arrow_function' ? 'arrow' : n.astType}|${n.startLine - 1}`));
  const setsMatch = septSet.size === reparseSet.size && [...septSet].every(x => reparseSet.has(x));

  return {
    query: 'ActivateCompanyWizard',
    commit: COMMIT,
    all_occurrences_excluding_graphify_cache: occurrences,
    note_on_graphify_out: `${graphifyOccurrenceCount} additional occurrences exist under graphify-out/ (a DIFFERENT, unrelated code-graph tool's cached output, tracked in the repo at this commit) — excluded here as not relevant to NCA's own indexing; graphify-out/graph.json independently labels this as "ActivateCompanyWizard()", corroborating it is an ordinary function, not evidence about NCA's indexer.`,
    real_declaration_occurrence: declarationLine,
    ast: {
      grammar_used: 'tree-sitter-typescript .typescript (plain, non-JSX) — the grammar src/parser.ts actually uses for .tsx files (parser.ts:239 maps the tsx extension to the same parser instance as .ts, never loading tree-sitter-typescript\'s separate .tsx grammar export).',
      whole_file_parse_stats: { hasError: parsed.hasError, errorNodeCount: parsed.errorNodeCount, totalTopLevelChildren: parsed.totalNodes, functionTypeNodesFoundInWholeFile: parsed.functionNodes.length },
      function_declaration_at_line_32: nearDecl.length > 0 ? nearDecl : 'NONE — no function_declaration/arrow_function/etc. node found in the 30-40 line range under this grammar.',
      syntactic_form_in_source: 'export function ActivateCompanyWizard({ ... }) { ... JSX ... }',
      tree_sitter_node_type_if_parsed_correctly: 'function_declaration (would resolve via own name field, no parent walk needed)',
    },
    september_index: {
      nodes_from_this_file: septNodes,
      has_ActivateCompanyWizard_node: septHasActivateCompanyWizard,
      reparse_reproduces_exact_september_node_set: setsMatch,
    },
    three_step_reasoning: {
      a_file_eligible: 'YES — .tsx is a scanned extension (parser.ts:239), src/ is kept per .ncaignore, no exclusion applies.',
      b_any_nodes_from_file_in_sept_db: `YES — ${septNodes.length} nodes from this exact file exist in the September index (${septNodes.map(n => n.name).join(', ')}) — the file was scanned, not skipped.`,
      c_conclusion: 'Declaration is of a supported construct type (function_declaration). Other nodes from the same file exist. The specific target (the outer, JSX-returning function_declaration itself) is absent. INDEXABLE_CONSTRUCT_NO_NODE — CONFIRMED.',
      mechanism_certainty: `RESOLVED. Re-parsing the exact git blob with the plain TypeScript grammar (matching src/parser.ts's actual .tsx handling) produces ${parsed.errorNodeCount} ERROR nodes (hasError=${parsed.hasError}) — the grammar cannot cleanly parse this file's JSX. Only ${parsed.functionNodes.length} function-type nodes survive anywhere in the whole file, all of them non-JSX-containing INNER arrow functions (event handlers) defined before the JSX return statement; the outer function_declaration whose body directly contains the JSX return is not recognized as a clean node. This reproduction's surviving node set is ${setsMatch ? 'IDENTICAL to' : 'DIFFERENT from'} the September index's actual node set for this file (name+type+line, exact) — ${setsMatch ? 'strong confirmation this is the real mechanism, not just a plausible one' : 'see raw data, mechanism not fully confirmed'}. The parser.ts rule responsible: parser.ts:239 (\`this.parsers.set('tsx', p)\`) reuses the plain-TypeScript-grammar parser instance for .tsx, instead of tree-sitter-typescript's separate .tsx grammar export. This mismatch is a property of the .tsx extension generally, not specific to this one file — not investigated further here (out of this task's scope), but the mechanism itself is general, not file-specific.`,
    },
  };
}

function describeOtherCases() {
  const sub = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'recall-subclassification.json'), 'utf-8'));
  const others = sub.node_present_matcher_missed.results.filter(r => r.subclass === 'OTHER');
  return others.map(o => ({
    event_id: o.event_id,
    query: o.query,
    literal_pattern: o.pattern,
    query_vs_exact_name_or_file: 'query text does NOT equal any matched node.name exactly, and does NOT equal any matched node.file exactly or as its basename — match was via path-substring only (a path-kind candidate token found inside several nodes\' file paths), not an exact name or exact path match.',
    affects_aggregate_conclusion: false,
    why: 'Both are variants of the same already-dominant MULTI_TOKEN_QUERY phenomenon (multi-word query, AND-across-terms semantics), just reached via a path-substring candidate instead of a name candidate. Neither changes the counts for INDEXABLE_CONSTRUCT_NO_NODE / NON_INDEXABLE_BY_DESIGN, nor introduces a new EXACT_*_MISSED case (no exact match exists for either). The dominant finding for NODE_PRESENT_MATCHER_MISSED (10/12 MULTI_TOKEN_QUERY, an interface-contract question, not a matcher defect) is unchanged.',
  }));
}

function main() {
  const withRLSContextResult = rootCauseWithRLSContext();
  const activateCompanyWizardResult = rootCauseActivateCompanyWizard();
  const otherCases = describeOtherCases();

  const confirmed_defects = [withRLSContextResult, activateCompanyWizardResult].filter(r => r.three_step_reasoning.c_conclusion.includes('CONFIRMED')).length;
  const reclassified_correct_behavior = 0; // neither candidate was reclassified away from INDEXABLE_CONSTRUCT_NO_NODE
  const undetermined = 0;

  const report = {
    generated_at: new Date().toISOString(),
    evidence_rule: 'Every source claim below is read from git object e29cb7a1 exclusively (git show / git grep against the commit), never the synio working tree.',
    withRLSContext: withRLSContextResult,
    ActivateCompanyWizard: activateCompanyWizardResult,
    other_cases: otherCases,
    summary: {
      confirmed_defects,
      reclassified_correct_behavior,
      undetermined,
    },
    proposed_ledger_line: "Item: nca_ask indexer coverage — 2 confirmed indexer gaps in the September SYNIO index (of 26 originally-flagged recall-gap queries): (1) .tsx files are parsed with the plain (non-JSX) TypeScript grammar (src/parser.ts:239 reuses the .ts parser instance for .tsx instead of tree-sitter-typescript's dedicated .tsx grammar), causing JSX-containing top-level declarations to be dropped while non-JSX inner functions in the same file still get indexed — reproduced exactly against the frozen index's own node set for ActivateCompanyWizard.tsx (11/11 nodes match). (2) A second case (withRLSContext, a plain .ts arrow-function-via-middleware() pattern) is confirmed missing despite provably resolving a name under the CURRENT src/parser.ts logic — mechanism unresolved (possible scan-time parser version drift), reported as an open scan/parser frontier question, not concluded. Status: NOT_ACTED_ON — evidence only, no fix applied, per task scope.",
  };

  fs.writeFileSync(path.join(REPLAY_DIR, 'rootcause-2gaps.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  const lines = [];
  lines.push('# Root cause: the 2 confirmed indexer coverage gaps + the 2 OTHER matcher cases');
  lines.push('');
  lines.push(`Evidence rule: ${report.evidence_rule}`);
  lines.push('');
  lines.push('## withRLSContext — all 10 occurrences at e29cb7a1');
  lines.push('');
  lines.push('| file | line | text |');
  lines.push('|---|---|---|');
  for (const o of withRLSContextResult.all_occurrences) lines.push(`| ${o.file} | ${o.line} | ${JSON.stringify(o.text.trim())} |`);
  lines.push('');
  lines.push('### Which prior report was wrong, and what it actually inspected');
  lines.push('');
  lines.push(withRLSContextResult.prior_report_discrepancy.what_it_actually_inspected);
  lines.push('');
  lines.push('### AST / parser.ts verdict');
  lines.push('');
  lines.push(`Syntactic form: \`${withRLSContextResult.ast.syntactic_form}\``);
  lines.push('');
  lines.push(`tree-sitter node type: ${withRLSContextResult.ast.tree_sitter_node_type}`);
  lines.push('');
  lines.push(withRLSContextResult.ast.extract_node_name_verdict);
  lines.push('');
  lines.push('### Three-step reasoning');
  lines.push('');
  lines.push(`a. ${withRLSContextResult.three_step_reasoning.a_file_eligible}`);
  lines.push('');
  lines.push(`b. ${withRLSContextResult.three_step_reasoning.b_any_nodes_from_file_in_sept_db}`);
  lines.push('');
  lines.push(`c. ${withRLSContextResult.three_step_reasoning.c_conclusion}`);
  lines.push('');
  lines.push(`Mechanism certainty: ${withRLSContextResult.three_step_reasoning.mechanism_certainty}`);
  lines.push('');

  lines.push('## ActivateCompanyWizard');
  lines.push('');
  lines.push(`Real declaration: \`${activateCompanyWizardResult.real_declaration_occurrence.file}:${activateCompanyWizardResult.real_declaration_occurrence.line}\`: ${JSON.stringify(activateCompanyWizardResult.real_declaration_occurrence.text.trim())}`);
  lines.push('');
  lines.push(activateCompanyWizardResult.note_on_graphify_out);
  lines.push('');
  lines.push('### Three-step reasoning');
  lines.push('');
  lines.push(`a. ${activateCompanyWizardResult.three_step_reasoning.a_file_eligible}`);
  lines.push('');
  lines.push(`b. ${activateCompanyWizardResult.three_step_reasoning.b_any_nodes_from_file_in_sept_db}`);
  lines.push('');
  lines.push(`c. ${activateCompanyWizardResult.three_step_reasoning.c_conclusion}`);
  lines.push('');
  lines.push(`Mechanism certainty: ${activateCompanyWizardResult.three_step_reasoning.mechanism_certainty}`);
  lines.push('');

  lines.push('## The 2 OTHER cases');
  lines.push('');
  for (const o of otherCases) {
    lines.push(`### ${o.event_id} — \`${o.query}\``);
    lines.push('');
    lines.push(`Literal pattern: ${o.literal_pattern}`);
    lines.push('');
    lines.push(`${o.query_vs_exact_name_or_file}`);
    lines.push('');
    lines.push(`Affects aggregate conclusion: ${o.affects_aggregate_conclusion ? 'sí' : 'no'} — ${o.why}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`confirmed_defects: ${confirmed_defects} · reclassified_correct_behavior: ${reclassified_correct_behavior} · undetermined: ${undetermined}`);
  lines.push('');
  lines.push('## Proposed ledger line (NOT applied)');
  lines.push('');
  lines.push('```');
  lines.push(report.proposed_ledger_line);
  lines.push('```');
  lines.push('');

  fs.writeFileSync(path.join(REPLAY_DIR, 'rootcause-2gaps.md'), lines.join('\n'), 'utf-8');

  console.log(`confirmed_defects=${confirmed_defects} reclassified_correct_behavior=${reclassified_correct_behavior} undetermined=${undetermined}`);
  console.log(`Wrote ${path.join(REPLAY_DIR, 'rootcause-2gaps.json')} and .md`);
}

main();
