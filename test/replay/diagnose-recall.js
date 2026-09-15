#!/usr/bin/env node
/**
 * Phase B, first evidence: classify the 26 in-scope queries Phase A left as
 * source_text_present_but_not_retrieved (report-drift.json) against the
 * frozen SEPTEMBER index's actual `nodes` table — not against grep, not
 * against opinion. Answers, per query: is there a plausible node in the
 * index the matcher failed to surface (NODE_PRESENT_MATCHER_MISSED), or did
 * the indexer never create one even though the text exists
 * (INDEXER_NOT_CAPTURED)?
 *
 * Read-only against both frozen indices (copies into scratch, never opens
 * the canonical files directly — same discipline as run.js's replay
 * harness). Makes NO change to NCA's matcher or indexer; this is a
 * classification of existing, already-frozen data.
 *
 * Canonical source of the 26: test/replay/report-drift.json's
 * results[].drift.verdict === 'source_text_present_but_not_retrieved'. Not
 * hand-copied — loaded directly, so this script breaks (loudly) if that
 * file's shape or count ever changes instead of silently working from a
 * stale second list.
 *
 * Candidate derivation: reuses drift.js's extractCandidates() UNCHANGED —
 * the exact same rule that already selected these 26 queries in the first
 * place (see report printed below for the rule, quoted from drift.js).
 *
 * Usage: node test/replay/diagnose-recall.js
 * Writes test/replay/recall-diagnosis.json / .md.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { extractCandidates } = require('./drift.js');

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');

const EXTRACT_CANDIDATES_RULE_SUMMARY =
  "drift.js:extractCandidates(query) — split on whitespace, strip surrounding punctuation, keep a token iff: " +
  "it looks like a path (contains '/' or ends in .ts/.tsx/.js/.jsx/.py/.json/.md/.sql/.env) OR is kebab-case (>=6 chars, e.g. 'build-prompt') OR " +
  "is camelCase/PascalCase (has an uppercase letter after position 0 AND a lowercase letter) OR is UPPER_SNAKE (contains '_', all-uppercase) OR " +
  "is snake_case (contains '_', all-lowercase) OR is $-prefixed (e.g. '$queryRaw'); AND the token (lowercased) is not in a small stopword list " +
  "(the/a/an/and/or/for/of/in/on/at/to/is/are/with/from/that/this/other/outside/already/bad/request); AND the identifier-shaped core is >=4 chars.";

function loadCanonical26() {
  const reportPath = path.join(REPLAY_DIR, 'report-drift.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const rows = report.results.filter(r => r.drift && r.drift.verdict === 'source_text_present_but_not_retrieved');
  return { rows, reportPath };
}

function copyReadonly(frozenPathTilde, label) {
  const frozenPath = frozenPathTilde.replace(/^~/, os.homedir());
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `nca-recall-diag-${label}-`));
  const copyPath = path.join(scratchDir, 'index.db');
  fs.copyFileSync(frozenPath, copyPath);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(copyPath)).digest('hex');
  return { copyPath, sha, cleanup: () => { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ } } };
}

/** Confirms the real `nodes` columns before any query — printed in the report, never assumed. */
function inspectNodesSchema(db) {
  const cols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  return cols;
}

const NAME_QUERY_SQL = 'SELECT id, type, name, file, line FROM nodes WHERE name = ? ORDER BY id';
const PATH_QUERY_SQL = 'SELECT id, type, name, file, line FROM nodes WHERE file LIKE ? ORDER BY id';
// Supplementary only — never changes the classification, which is decided by
// exact match (NAME_QUERY_SQL/PATH_QUERY_SQL) per the documented rule. Surfaces
// substring near-misses (e.g. query 'manageAppointment' vs node
// 'handleManageAppointment') for a human reader, without folding them into the
// mechanical class.
const NAME_NEAR_MISS_SQL = 'SELECT id, type, name, file, line FROM nodes WHERE name LIKE ? AND name != ? ORDER BY id LIMIT 5';

function queryCandidate(db, candidate) {
  if (candidate.kind === 'path') {
    const rows = db.prepare(PATH_QUERY_SQL).all(`%${candidate.token}%`);
    return { sql: PATH_QUERY_SQL, param: `%${candidate.token}%`, rows };
  }
  const rows = db.prepare(NAME_QUERY_SQL).all(candidate.token);
  return { sql: NAME_QUERY_SQL, param: candidate.token, rows };
}

function main() {
  const { rows: canonical26, reportPath } = loadCanonical26();

  const sept = copyReadonly('~/.nca/replay/synio-frozen.db', 'sept');
  const june = copyReadonly('~/.nca/replay/synio-baseline-13c01e51.db', 'june');

  // Verify the read-only copies match the canonical frozen files' recorded
  // hashes before trusting anything derived from them.
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8'));
  const baselineManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'baseline-manifest.json'), 'utf-8'));
  if (sept.sha !== manifest.index.storage.sha256) {
    throw new Error(`September index sha256 mismatch: expected ${manifest.index.storage.sha256}, got ${sept.sha}`);
  }
  if (june.sha !== baselineManifest.index.storage.sha256) {
    throw new Error(`June index sha256 mismatch: expected ${baselineManifest.index.storage.sha256}, got ${june.sha}`);
  }

  const septDb = new Database(sept.copyPath, { readonly: true });
  const juneDb = new Database(june.copyPath, { readonly: true });

  const septSchema = inspectNodesSchema(septDb);
  const juneSchema = inspectNodesSchema(juneDb);

  const results = [];
  for (const row of canonical26) {
    // Re-derive candidates with the SAME rule already used to select this
    // query (drift.js), not a second, hand-tuned extraction.
    const candidates = extractCandidates(row.query);

    const candidateResults = candidates.map(c => {
      const sept_ = queryCandidate(septDb, c);
      const june_ = queryCandidate(juneDb, c);
      return {
        token: c.token,
        kind: c.kind,
        sept_match_count: sept_.rows.length,
        sept_matches: sept_.rows,
        sept_sql: sept_.sql,
        sept_param: sept_.param,
        june_match_count: june_.rows.length,
        june_matches: june_.rows,
      };
    });

    const anySeptMatch = candidateResults.some(c => c.sept_match_count > 0);
    const anyJuneMatch = candidateResults.some(c => c.june_match_count > 0);

    // Classification (task 5). All 26 rows are, by construction (drift.js's
    // own selection criterion for this verdict), confirmed present as TEXT
    // in synio@<sept commit> via git grep already — that's why they're in
    // this list at all — so NOT_IDENTIFIER_QUERY structurally cannot occur
    // here (every row has >=1 candidate). Recorded, not forced.
    let cls;
    let note;
    if (candidates.length === 0) {
      cls = 'NOT_IDENTIFIER_QUERY';
      note = 'no identifier-shaped candidate — should not occur for a source_text_present_but_not_retrieved row; flagging as evidence of a fixture inconsistency if it ever does.';
    } else if (anySeptMatch) {
      cls = 'NODE_PRESENT_MATCHER_MISSED';
      const hit = candidateResults.find(c => c.sept_match_count > 0);
      note = `${hit.sept_match_count} node(s) in the September index named/pathed '${hit.token}' (e.g. id=${hit.sept_matches[0].id} type=${hit.sept_matches[0].type} ${hit.sept_matches[0].file}:${hit.sept_matches[0].line}); nca_ask's search() returned no match for this query regardless.`;
    } else {
      // No node in the September index for any candidate, but drift.js's git
      // grep already confirmed the text exists in the September commit's
      // source tree — so the indexer did not turn it into a node.
      const anyGitTextExists = row.drift.candidates.some(c => c.exists);
      if (anyGitTextExists) {
        cls = 'INDEXER_NOT_CAPTURED';
        note = `text confirmed present via git grep at synio@e29cb7a1 (drift.js evidence: ${row.drift.candidates.find(c => c.exists).evidence}), but no node in the September index nodes table matches any candidate by exact name or file substring.`;
        // Supplementary, does not affect classification: substring near-misses.
        for (const c of candidates) {
          if (c.kind === 'path') continue;
          const nearMisses = septDb.prepare(NAME_NEAR_MISS_SQL).all(`%${c.token}%`, c.token);
          if (nearMisses.length > 0) {
            note += ` Substring near-miss (not exact, not counted): ${nearMisses.map(n => `${n.name}@${n.file}:${n.line}`).join('; ')}.`;
          }
        }
      } else {
        cls = 'UNDETERMINED';
        note = 'candidates extracted but neither the September nodes table nor the original git-grep evidence confirms text presence — contradicts this row being in the source_text_present_but_not_retrieved list; insufficient/inconsistent evidence, not forcing a call.';
      }
    }

    results.push({
      event_id: row.event_id,
      query: row.query,
      project_arg: row.project_arg,
      class: cls,
      candidates_used: candidates.map(c => ({ token: c.token, kind: c.kind })),
      sept_matches: candidateResults.filter(c => c.sept_match_count > 0).map(c => ({ token: c.token, nodes: c.sept_matches })),
      in_june_index: anyJuneMatch ? 'yes' : 'no',
      evidence_note: note,
    });
  }

  septDb.close();
  juneDb.close();
  sept.cleanup();
  june.cleanup();

  const counts = { NODE_PRESENT_MATCHER_MISSED: 0, INDEXER_NOT_CAPTURED: 0, NOT_IDENTIFIER_QUERY: 0, UNDETERMINED: 0 };
  for (const r of results) counts[r.class]++;

  const report = {
    generated_at: new Date().toISOString(),
    source_of_26: reportPath,
    september_index: { sha256: sept.sha, synio_commit: manifest.index.synio_commit },
    june_index: { sha256: june.sha, synio_commit: baselineManifest.index.synio_commit, role: 'secondary/informative column only — see task context, not used for classification' },
    nodes_schema_september: septSchema,
    nodes_schema_june: juneSchema,
    candidate_extraction_rule: EXTRACT_CANDIDATES_RULE_SUMMARY,
    name_query_sql: NAME_QUERY_SQL,
    path_query_sql: PATH_QUERY_SQL,
    counts,
    results,
  };

  fs.writeFileSync(path.join(REPLAY_DIR, 'recall-diagnosis.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  const lines = [];
  lines.push('# nca_ask recall gap diagnosis — Phase B, first evidence');
  lines.push('');
  lines.push(`Source of the 26: \`${reportPath}\` (results[].drift.verdict === 'source_text_present_but_not_retrieved'). Not hand-copied.`);
  lines.push('');
  lines.push('## Candidate derivation rule (verbatim, drift.js:extractCandidates — unchanged, reused)');
  lines.push('');
  lines.push(EXTRACT_CANDIDATES_RULE_SUMMARY);
  lines.push('');
  lines.push('## `nodes` table schema (September index, inspected, not assumed)');
  lines.push('');
  lines.push('`' + septSchema.join(', ') + '`');
  lines.push('');
  lines.push('## SQL used');
  lines.push('');
  lines.push('Identifier candidates: `' + NAME_QUERY_SQL + '`');
  lines.push('');
  lines.push('Path candidates: `' + PATH_QUERY_SQL + '` (param wrapped `%token%`)');
  lines.push('');
  lines.push('## Counts by class (26 total)');
  lines.push('');
  lines.push('| class | count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(counts)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Phase B implication (mechanical, no implementation recommended)');
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  lines.push('');
  if (dominant[0] === 'NODE_PRESENT_MATCHER_MISSED') {
    lines.push(`Dominant class: NODE_PRESENT_MATCHER_MISSED (${dominant[1]}/26) — the node exists in the index; nca_ask's matcher/search is the layer failing to surface it. Recall/matching is a candidate for a real Phase B finding.`);
  } else if (dominant[0] === 'INDEXER_NOT_CAPTURED') {
    lines.push(`Dominant class: INDEXER_NOT_CAPTURED (${dominant[1]}/26) — the text exists in source but the scanner/indexer never created a node for it. The larger gap is indexing, not matching.`);
  } else if (dominant[0] === 'NOT_IDENTIFIER_QUERY') {
    lines.push(`Dominant class: NOT_IDENTIFIER_QUERY (${dominant[1]}/26) — nca_ask may be the wrong interface for these queries.`);
  } else {
    lines.push(`Dominant class: UNDETERMINED (${dominant[1]}/26) — evidence insufficient for a mechanical read; no implication drawn.`);
  }
  lines.push('');
  lines.push('## 26 rows');
  lines.push('');
  lines.push('| event_id | query | class | candidates | September node(s) | in June index | note |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const cands = r.candidates_used.map(c => c.token).join(', ') || '—';
    const nodes = r.sept_matches.length > 0
      ? r.sept_matches.map(m => m.nodes.map(n => `#${n.id} ${n.type}:${n.name}@${n.file}:${n.line}`).join('; ')).join(' | ')
      : '—';
    lines.push(`| ${r.event_id} | ${JSON.stringify(r.query)} | ${r.class} | ${cands} | ${nodes} | ${r.in_june_index} | ${r.evidence_note} |`);
  }
  lines.push('');

  fs.writeFileSync(path.join(REPLAY_DIR, 'recall-diagnosis.md'), lines.join('\n'), 'utf-8');

  console.log(`Wrote ${path.join(REPLAY_DIR, 'recall-diagnosis.json')} and .md`);
  console.log(`Counts: ${JSON.stringify(counts)}`);
}

main();
