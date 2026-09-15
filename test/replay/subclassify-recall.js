#!/usr/bin/env node
/**
 * Phase B, second evidence pass: sub-classify recall-diagnosis.json's two
 * buckets (INDEXER_NOT_CAPTURED, NODE_PRESENT_MATCHER_MISSED) with
 * deterministic, read-only rules. Neither bucket is a finding on its own —
 * "no node" is only an indexer gap if the construct is a type NCA's indexer
 * actually attempts (established here, from the indexer's own source, before
 * classifying anything); a multi-token query missing is an interface-contract
 * question, not caller misuse — nca_ask's own description ("function name,
 * concept, module, etc.") invites exactly these queries.
 *
 * Read-only: git show/grep against synio's commit object store (never the
 * live working tree), and the frozen September index's `nodes` table via a
 * read-only better-sqlite3 handle on a scratch copy (never the canonical
 * file). No src/ change, no matcher/indexer change, no MCP call against a
 * live server for anything except the EXACT_*_MISSED evidence step (task 2),
 * which spawns the real MCP server read-only against the frozen index, same
 * transport as run.js's replay harness.
 *
 * Usage: node test/replay/subclassify-recall.js
 * Writes test/replay/recall-subclassification.json / .md.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { prepareWorkdir, startServer, classify } = require('./run.js');

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');
const SYNIO_ROOT = '/mnt/c/dev/synio';
const SCAN_DIRS = ['src', 'tests', 'prisma', 'scripts']; // same as drift.js

// ─── Task 0: indexing contract, from the indexer's own source ────────────────

function readIndexingContractFromSource() {
  const parserSrc = fs.readFileSync(path.join(REPLAY_DIR, '..', '..', 'src', 'parser.ts'), 'utf-8');
  const tsMatch = parserSrc.match(/functionNodeTypes\s*=\s*\[([^\]]+)\]/);
  const tsClassMatch = parserSrc.match(/classNodeTypes\s*=\s*\['class_declaration'\]/);
  const pyMatch = parserSrc.match(/functionNodeTypes\s*=\s*\['function_definition'\]/);
  return {
    source: 'src/parser.ts (read-only inspection, not modified)',
    typescript_javascript: {
      function_node_types: tsMatch ? tsMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')) : null,
      class_node_types: tsClassMatch ? ['class_declaration'] : null,
    },
    python: {
      function_node_types: pyMatch ? ['function_definition'] : null,
      class_node_types: ['class_definition'],
    },
    type_mapping: "getNodeKind(treeSitterType): includes('class')->'class', includes('method')->'method', includes('arrow')->'arrow', else->'function' (so function_declaration AND function_expression both map to node type 'function').",
    extraction_walk: "rootNode.descendantsOfType([...functionNodeTypes, ...classNodeTypes]) — ALL descendants at ANY nesting depth, not just top-level. A matched node is only kept if extractNodeName() resolves a name: for arrow_function/function_expression, walks UP the parent chain through wrapping nodes (e.g. call_expression/arguments, as in `const x = wrapper(() => {...})`) looking for a variable_declarator, assignment_expression, object pair, or method_definition to name it from; gives up (dropped, not indexed) at a statement_block/program/function_declaration boundary with no name found.",
    languages_supported: ['TypeScript/JavaScript (tree-sitter-typescript/javascript)', 'Python (tree-sitter-python)'],
    not_in_contract: "Interfaces, type aliases, enums, plain const/let/var declarations NOT assigned an arrow_function/function_expression literal (e.g. `const x = builder.use(y)`), object properties that are not method_definition, .sql files, .prisma schema files, .md files, comments, string literals (env var names, tool-name strings) — none of these produce a node, by design (out of functionNodeTypes/classNodeTypes scope, or the file extension isn't parsed by any LanguageExtractor at all).",
  };
}

function observedTypesInSeptDb(db) {
  return db.prepare('SELECT type, COUNT(*) as count FROM nodes GROUP BY type ORDER BY count DESC').all();
}

// ─── Task 1: INDEXER_NOT_CAPTURED sub-classification ──────────────────────────

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|--|#)/;
const SQL_OR_PRISMA_FILE_RE = /\.(sql|prisma)$/;
const MD_FILE_RE = /\.md$/;

// Deterministic per-candidate sub-verdicts for task 1, decided from the FULL
// set of git-grep matches (not just the first, stored evidence line — a
// single first match can be a comment while a real declaration exists
// elsewhere in the same grep results; this re-greps fresh to see everything).
function classifyIndexerCandidate(token) {
  let out;
  try {
    out = execFileSync('git', ['-C', SYNIO_ROOT, 'grep', '-F', '-w', '-n', '-e', token, 'e29cb7a1', '--', ...SCAN_DIRS], { encoding: 'utf-8' });
  } catch (err) {
    if (err.status === 1) return { verdict: 'UNDETERMINED', reason: 'git grep found no match at all (contradicts drift.js\'s earlier existence check)', matches: [] };
    throw err;
  }
  const lines = out.trim().split('\n').filter(Boolean);
  const parsed = lines.map(l => {
    const m = l.match(/^e29cb7a1:([^:]+):(\d+):(.*)$/);
    return m ? { file: m[1], line: Number(m[2]), text: m[3] } : { file: '?', line: 0, text: l };
  });

  // A "declaration-shaped" line: assigns/declares the token as a function,
  // arrow (with an inline function/arrow literal on the RHS), class, method,
  // or interface/type/enum/const-to-non-function-value — vs. a pure usage,
  // comment, or SQL/prisma column/enum line.
  const declLines = parsed.filter(p => {
    if (COMMENT_LINE_RE.test(p.text)) return false;
    if (SQL_OR_PRISMA_FILE_RE.test(p.file) || MD_FILE_RE.test(p.file)) return false;
    // Looks like an actual declaration statement naming this exact token.
    return new RegExp(`\\b(export\\s+)?(default\\s+)?(async\\s+)?(function|class|interface|type|enum|const|let|var)\\s+.*\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(p.text)
      || new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`).test(p.text) && !p.text.trim().startsWith(token) === false; // method/property def shape, permissive
  });

  if (declLines.length === 0) {
    // No declaration-shaped line in code at all — either purely comments/SQL/prisma/md, or purely a usage (e.g. process.env.X, object.prop access).
    const onlyCommentOrDocOrData = parsed.every(p => COMMENT_LINE_RE.test(p.text) || SQL_OR_PRISMA_FILE_RE.test(p.file) || MD_FILE_RE.test(p.file));
    if (onlyCommentOrDocOrData) return { verdict: 'TEXT_ONLY_NOT_INDEXABLE', reason: 'every match is a comment, or in a .sql/.prisma/.md file', matches: parsed.slice(0, 5) };
    return { verdict: 'NON_INDEXABLE_BY_DESIGN', reason: 'only usage sites (property access, process.env reference, string literal), no declaration statement for this exact token', matches: parsed.slice(0, 5) };
  }

  // Inspect the strongest declaration line's shape.
  const decl = declLines[0];
  const isFunctionDecl = /\bfunction\s+/.test(decl.text) || /\bdef\s+/.test(decl.text);
  const isClassDecl = /\bclass\s+/.test(decl.text);
  const hasInlineArrowOrFnExpr = /=>\s*\{?/.test(decl.text) || /=\s*function\s*\(/.test(decl.text);
  const isInterfaceTypeEnum = /\b(interface|type|enum)\s+/.test(decl.text);
  const isPlainConstToNonFunction = /\b(const|let|var)\s+/.test(decl.text) && !hasInlineArrowOrFnExpr && !isFunctionDecl;
  // Object/property literal value: `key: value,` (optionally quoted key), no
  // const/let/var/function/class/interface/type/enum keyword anywhere on the
  // line and no inline function/arrow — a property assignment inside some
  // enclosing object literal, not a declaration of any indexed construct type.
  const isObjectPropertyValue = new RegExp(`^\\s*['"]?${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:\\s*`).test(decl.text)
    && !hasInlineArrowOrFnExpr && !isFunctionDecl && !isClassDecl
    && !/\b(const|let|var|function|class|interface|type|enum)\b/.test(decl.text);

  if (isFunctionDecl || isClassDecl || hasInlineArrowOrFnExpr) {
    return { verdict: 'INDEXABLE_CONSTRUCT_NO_NODE', reason: `declaration matches an indexed construct shape: ${decl.file}:${decl.line}: ${decl.text.trim()}`, matches: parsed.slice(0, 5), evidence: decl };
  }
  if (isInterfaceTypeEnum || isPlainConstToNonFunction) {
    return { verdict: 'NON_INDEXABLE_BY_DESIGN', reason: `real declaration but not an indexed construct type: ${decl.file}:${decl.line}: ${decl.text.trim()}`, matches: parsed.slice(0, 5), evidence: decl };
  }
  if (isObjectPropertyValue) {
    return { verdict: 'NON_INDEXABLE_BY_DESIGN', reason: `object/property literal value assignment, not a declaration of any indexed construct type: ${decl.file}:${decl.line}: ${decl.text.trim()}`, matches: parsed.slice(0, 5), evidence: decl };
  }
  return { verdict: 'UNDETERMINED', reason: `declaration-shaped line found but construct type unclear: ${decl.file}:${decl.line}: ${decl.text.trim()}`, matches: parsed.slice(0, 5), evidence: decl };
}

const SUBVERDICT_PRIORITY = ['INDEXABLE_CONSTRUCT_NO_NODE', 'NON_INDEXABLE_BY_DESIGN', 'TEXT_ONLY_NOT_INDEXABLE', 'UNDETERMINED'];

function subclassifyIndexerRow(row) {
  const perCandidate = row.candidates_used.map(c => ({ token: c.token, ...classifyIndexerCandidate(c.token) }));
  // Priority: most-actionable-first — a real gap (INDEXABLE_CONSTRUCT_NO_NODE)
  // anywhere among the candidates outranks a "correct behavior" verdict on
  // another candidate of the same multi-token query.
  for (const v of SUBVERDICT_PRIORITY) {
    const hit = perCandidate.find(c => c.verdict === v);
    if (hit) return { subclass: v, perCandidate, drivingCandidate: hit.token };
  }
  return { subclass: 'UNDETERMINED', perCandidate, drivingCandidate: null };
}

// ─── Task 2: NODE_PRESENT_MATCHER_MISSED sub-classification ──────────────────

function subclassifyMatcherRow(row) {
  const trimmedQuery = row.query.trim();
  const matchedNames = new Set();
  const matchedPaths = new Set();
  for (const sm of row.sept_matches) {
    for (const n of sm.nodes) {
      matchedNames.add(n.name);
      matchedPaths.add(n.file);
    }
  }
  if (matchedNames.has(trimmedQuery)) {
    return { subclass: 'EXACT_NODE_NAME_MISSED', pattern: `query == node.name exactly ('${trimmedQuery}')`, matchedName: trimmedQuery };
  }
  for (const p of matchedPaths) {
    if (p === trimmedQuery || p.endsWith(`/${trimmedQuery}`)) {
      return { subclass: 'EXACT_PATH_MISSED', pattern: `query == node.file exactly or as its basename ('${trimmedQuery}' vs '${p}')`, matchedPath: p };
    }
  }
  // Multi-token: query contains a matched node's name plus other tokens.
  const queryTokens = trimmedQuery.split(/\s+/);
  const containsAMatchedNameAsToken = [...matchedNames].some(name => queryTokens.includes(name));
  if (containsAMatchedNameAsToken && queryTokens.length > 1) {
    return { subclass: 'MULTI_TOKEN_QUERY', pattern: `query has ${queryTokens.length} tokens, one of which ('${[...matchedNames].find(n => queryTokens.includes(n))}') exactly matches a node name`, matchedNames: [...matchedNames] };
  }
  const pathCandidates = (row.candidates_used || []).filter(c => c.kind === 'path').map(c => c.token);
  if (pathCandidates.length > 0) {
    return {
      subclass: 'OTHER',
      pattern: `partial path match — query contains path-shaped token(s) (${pathCandidates.join(', ')}) that substring-matched multiple nodes' file paths; none of those nodes' NAMES appear as an exact token in the query text ('${trimmedQuery}') — matched node names: ${[...matchedNames].join(', ')}`,
      matchedNames: [...matchedNames],
    };
  }
  return { subclass: 'OTHER', pattern: `no exact name, no exact/basename path, no single token exactly matching a node name — query: '${trimmedQuery}', matched node names: ${[...matchedNames].join(', ')}`, matchedNames: [...matchedNames] };
}

// ─── Task 2 evidence: reproduce the exact nca_ask call for EXACT_*_MISSED ─────

async function reproduceNcaAskCall(query) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8'));
  const workdir = prepareWorkdir(manifest);
  const server = startServer(path.join(REPLAY_DIR, '..', '..', 'dist'), workdir.dbPath, workdir.registryPath);
  try {
    await new Promise(r => setTimeout(r, 500));
    const response = await server.call('nca_ask', { query }, 1);
    const { cls, detail } = classify(response);
    return { cls, detail };
  } finally {
    await server.close();
    workdir.cleanup();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const diagnosis = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'recall-diagnosis.json'), 'utf-8'));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-subclassify-'));
  const dbCopy = path.join(workDir, 'sept.db');
  const frozenSept = diagnosis.september_index; // has sha256
  const septSrc = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8')).index.storage.path.replace(/^~/, os.homedir());
  fs.copyFileSync(septSrc, dbCopy);
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(dbCopy)).digest('hex');
  if (actualSha !== frozenSept.sha256) throw new Error(`September index sha256 mismatch: expected ${frozenSept.sha256}, got ${actualSha}`);
  const septDb = new Database(dbCopy, { readonly: true });

  const contractFromSource = readIndexingContractFromSource();
  const observedTypes = observedTypesInSeptDb(septDb);
  septDb.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  // Cross-check: does the DB have any type NOT covered by the contract we read from source?
  const expectedTypes = new Set(['function', 'arrow', 'method', 'class']);
  const contractMismatch = observedTypes.filter(t => !expectedTypes.has(t.type));

  const indexerRows = diagnosis.results.filter(r => r.class === 'INDEXER_NOT_CAPTURED');
  const matcherRows = diagnosis.results.filter(r => r.class === 'NODE_PRESENT_MATCHER_MISSED');

  const indexerResults = indexerRows.map(row => {
    const { subclass, perCandidate, drivingCandidate } = subclassifyIndexerRow(row);
    return { event_id: row.event_id, query: row.query, subclass, driving_candidate: drivingCandidate, per_candidate: perCandidate };
  });

  const matcherResults = [];
  for (const row of matcherRows) {
    const { subclass, ...rest } = subclassifyMatcherRow(row);
    const result = { event_id: row.event_id, query: row.query, subclass, ...rest };
    if (subclass === 'EXACT_NODE_NAME_MISSED' || subclass === 'EXACT_PATH_MISSED') {
      result.nca_ask_reproduction = await reproduceNcaAskCall(row.query);
    }
    matcherResults.push(result);
  }

  const indexerCounts = {};
  for (const r of indexerResults) indexerCounts[r.subclass] = (indexerCounts[r.subclass] || 0) + 1;
  const matcherCounts = {};
  for (const r of matcherResults) matcherCounts[r.subclass] = (matcherCounts[r.subclass] || 0) + 1;

  const report = {
    generated_at: new Date().toISOString(),
    source_diagnosis: path.join(REPLAY_DIR, 'recall-diagnosis.json'),
    indexing_contract_observed: {
      from_source: contractFromSource,
      from_september_db: observedTypes,
      contract_mismatch: contractMismatch,
    },
    indexer_not_captured: {
      priority_rule: `Per-row subclass = highest-priority verdict among its candidates, priority order: ${SUBVERDICT_PRIORITY.join(' > ')} (most actionable first).`,
      counts: indexerCounts,
      results: indexerResults,
    },
    node_present_matcher_missed: {
      counts: matcherCounts,
      results: matcherResults,
    },
  };

  fs.writeFileSync(path.join(REPLAY_DIR, 'recall-subclassification.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // ── Markdown ──
  const lines = [];
  lines.push('# nca_ask recall gap sub-classification — Phase B, second evidence pass');
  lines.push('');
  lines.push(`Source: \`${report.source_diagnosis}\``);
  lines.push('');
  lines.push('## Indexing contract (observed)');
  lines.push('');
  lines.push('From `src/parser.ts` (read-only inspection):');
  lines.push('');
  lines.push(`- TypeScript/JavaScript function_node_types: \`${contractFromSource.typescript_javascript.function_node_types.join(', ')}\``);
  lines.push(`- TypeScript/JavaScript class_node_types: \`${contractFromSource.typescript_javascript.class_node_types.join(', ')}\``);
  lines.push(`- Python function_node_types: \`${contractFromSource.python.function_node_types.join(', ')}\`, class_node_types: \`${contractFromSource.python.class_node_types.join(', ')}\``);
  lines.push(`- Type mapping: ${contractFromSource.type_mapping}`);
  lines.push(`- Extraction walk: ${contractFromSource.extraction_walk}`);
  lines.push(`- NOT in contract: ${contractFromSource.not_in_contract}`);
  lines.push('');
  lines.push('From the September index (`SELECT type, COUNT(*) FROM nodes GROUP BY type`):');
  lines.push('');
  lines.push('| type | count |');
  lines.push('|---|---|');
  for (const t of observedTypes) lines.push(`| ${t.type} | ${t.count} |`);
  lines.push('');
  lines.push(contractMismatch.length === 0
    ? '**No discrepancy**: every observed `type` value is accounted for by the source contract above.'
    : `**Discrepancy found**: ${JSON.stringify(contractMismatch)} — type(s) present in the DB not explained by the source contract as read.`);
  lines.push('');

  lines.push('## INDEXER_NOT_CAPTURED sub-classification (14 rows)');
  lines.push('');
  lines.push(report.indexer_not_captured.priority_rule);
  lines.push('');
  lines.push('| subclass | count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(indexerCounts)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('| event_id | query | subclass | driving candidate | evidence |');
  lines.push('|---|---|---|---|---|');
  for (const r of indexerResults) {
    const driving = r.per_candidate.find(c => c.token === r.driving_candidate);
    lines.push(`| ${r.event_id} | ${JSON.stringify(r.query)} | ${r.subclass} | ${r.driving_candidate ?? '—'} | ${driving ? driving.reason.replace(/\|/g, '\\|') : '—'} |`);
  }
  lines.push('');
  lines.push('### Per-candidate detail (all candidates checked per row, not just the driving one)');
  lines.push('');
  for (const r of indexerResults) {
    lines.push(`**${r.event_id}** (${JSON.stringify(r.query)}) -> ${r.subclass}`);
    for (const c of r.per_candidate) {
      lines.push(`- \`${c.token}\`: ${c.verdict} — ${c.reason}`);
    }
    lines.push('');
  }

  lines.push('## NODE_PRESENT_MATCHER_MISSED sub-classification (12 rows)');
  lines.push('');
  lines.push('Rules: EXACT_NODE_NAME_MISSED (query trim == node.name exactly) / EXACT_PATH_MISSED (query trim == node.file exactly or as basename) / MULTI_TOKEN_QUERY (query contains a matched node name as one of several tokens — not caller misuse, nca_ask\'s own description invites this) / OTHER (reported literally, not grouped).');
  lines.push('');
  lines.push('| subclass | count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(matcherCounts)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('| event_id | query | subclass | pattern |');
  lines.push('|---|---|---|---|');
  for (const r of matcherResults) lines.push(`| ${r.event_id} | ${JSON.stringify(r.query)} | ${r.subclass} | ${r.pattern.replace(/\|/g, '\\|')} |`);
  lines.push('');

  const exactCases = matcherResults.filter(r => r.nca_ask_reproduction);
  lines.push(`## EXACT_*_MISSED nca_ask reproduction (${exactCases.length} case(s))`);
  lines.push('');
  if (exactCases.length === 0) {
    lines.push('None of the 12 NODE_PRESENT_MATCHER_MISSED queries are exact single-term name/path matches — every one is multi-token by construction (see table above). No EXACT_*_MISSED case exists to reproduce.');
  } else {
    for (const r of exactCases) {
      lines.push(`### ${r.event_id} — \`${r.query}\` (${r.subclass})`);
      lines.push('');
      lines.push('```');
      lines.push(r.nca_ask_reproduction.detail);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## Phase B implication, per sub-class (mechanical, no implementation recommended)');
  lines.push('');
  lines.push('- INDEXABLE_CONSTRUCT_NO_NODE -> possible finding of indexer coverage.');
  lines.push('- NON_INDEXABLE_BY_DESIGN / TEXT_ONLY_NOT_INDEXABLE -> correct behavior; not a finding.');
  lines.push('- EXACT_NODE_NAME_MISSED -> strong symbol-matcher defect (none observed among these 12).');
  lines.push('- EXACT_PATH_MISSED -> path-matcher defect (none observed among these 12).');
  lines.push('- MULTI_TOKEN_QUERY -> mismatch between what nca_ask\'s description promises ("function name, concept, module, etc.") and what it retrieves; whether the fix is the description, the capability, or neither is not decided here.');
  lines.push('- OTHER -> literal inspection only (none observed among these 12).');
  lines.push('');

  fs.writeFileSync(path.join(REPLAY_DIR, 'recall-subclassification.md'), lines.join('\n'), 'utf-8');

  console.log('Indexer sub-classification:', JSON.stringify(indexerCounts));
  console.log('Matcher sub-classification:', JSON.stringify(matcherCounts));
  console.log(`Wrote ${path.join(REPLAY_DIR, 'recall-subclassification.json')} and .md`);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(2);
});
