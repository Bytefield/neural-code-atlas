#!/usr/bin/env node
/**
 * Frozen nca_ask replay harness — Phase A exit gate (Replay B: drift report).
 *
 * Replays the 64 nca_ask calls from the SYNIO Phase 0 baseline corpus against
 * the CURRENT (September 2026) frozen SYNIO index, through the real MCP stdio
 * transport (same path Claude Code itself uses), and classifies every
 * response deterministically. See test/fixtures/replay/manifest.json for the
 * full fixture description, the classifier rules, and known caveats.
 *
 * This is "Replay B" — because the index here keeps advancing with synio's
 * real code, a miss here can mean either an NCA regression or ordinary code
 * drift, and this script cannot tell those apart on its own. It writes:
 *   - report.json / report.md — the GATE report. Three of its four criteria
 *     (noisy_fallback, product_error, clean_no_match) are about NCA's
 *     behavior against this current index and are meaningful gates on their
 *     own. The fourth (direct_hit regression) is NOT decided here — see
 *     test/replay/replay-a.js, which isolates regression from drift by
 *     running two NCA builds against the SAME frozen June index. This script
 *     reads replay-a-report.json (a separate, already-run artifact) to fill
 *     in that fourth criterion; it does not run Replay A itself.
 *   - report-drift.json / report-drift.md — pure information, no gate: the
 *     drift/source-text analysis (test/replay/drift.js) for every clean_no_match,
 *     and the historical (June 2026 live-session) traceability table.
 *
 * Test-side only. Not a product command — there is no `nca replay` anywhere in src/.
 *
 * Requires test/fixtures/replay/historical-classes.json (run
 * `node test/replay/historical.js` once) and test/replay/replay-a-report.json
 * (run `node test/replay/replay-a.js --reference-dist <95d52b4 dist>` once —
 * see baseline-manifest.json) to exist before the gate report can be built.
 *
 * Usage:
 *   node test/replay/run.js [--dist <path>] [--out-prefix <path>]
 *       [--capture-golden <dir>] [--check]
 *
 *   --dist <path>          Directory containing mcp.js to spawn. Default: <repo>/dist.
 *   --out-prefix <path>    Write report to <path>.json / <path>.md instead of the
 *                          default test/replay/report.json / report.md. Used to
 *                          keep a pre-fix validation run from clobbering the real report.
 *   --capture-golden <dir> For every direct_hit query, write <dir>/<event_id>.txt
 *                          with the normalized output. Informational only (Replay B) —
 *                          shows whether direct_hit content on the CURRENT index has
 *                          changed since the pre-#54 build; does not gate.
 *   --check                Regenerate report.json and diff it against the last
 *                          committed one; exit non-zero (and print the diff) if the
 *                          classifier's per-query result changed for any query in the
 *                          frozen fixture. Covers Replay B's own index only — Replay A
 *                          has its own `node test/replay/replay-a.js --reference-dist
 *                          <dist> --check` (needs the June build, not always at hand).
 *                          Run as its own step, not part of test/run.js, since it
 *                          spawns a real child process and is slow relative to that suite.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { classifyQuery } = require('./drift.js');

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');
const REPO_ROOT = path.join(REPLAY_DIR, '..', '..');

// Single source of truth for nca_ask result classification — shared with the
// corpus extractor's result_class field (src/corpus/nca-ask-result-class.ts).
// Do not reimplement these rules here; import them.
const {
  classifyNcaAskResult,
  normalizeNcaAskOutput,
  KNOWN_ENV_ERROR_RE,
} = require(path.join(REPO_ROOT, 'dist', 'corpus', 'nca-ask-result-class.js'));

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dist: path.join(REPO_ROOT, 'dist'), outPrefix: path.join(REPLAY_DIR, 'report'), captureGolden: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') out.dist = path.resolve(argv[++i]);
    else if (argv[i] === '--out-prefix') out.outPrefix = path.resolve(argv[++i]);
    else if (argv[i] === '--capture-golden') out.captureGolden = path.resolve(argv[++i]);
    else if (argv[i] === '--check') out.check = true;
  }
  return out;
}

// ─── Fixture loading ────────────────────────────────────────────────────────

function loadQueries() {
  const file = path.join(FIXTURE_DIR, 'queries.jsonl');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8'));
}

function resolveFrozenDbPath(manifest) {
  const inRepo = path.join(FIXTURE_DIR, 'synio-frozen.db');
  if (fs.existsSync(inRepo)) return inRepo;
  const external = manifest.index.storage.path.replace(/^~/, os.homedir());
  if (!fs.existsSync(external)) {
    throw new Error(
      `Frozen index not found at either ${inRepo} or ${external}. ` +
      `See manifest.index.storage for how it should have been placed.`
    );
  }
  return external;
}

// ─── Isolated per-run workdir (never touch the frozen source or live projects) ──

function prepareWorkdir(manifest) {
  const frozenDbPath = resolveFrozenDbPath(manifest);
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(frozenDbPath)).digest('hex');
  const expectedSha = manifest.index.storage.sha256;
  if (actualSha !== expectedSha) {
    throw new Error(
      `Frozen index sha256 mismatch: expected ${expectedSha}, got ${actualSha} at ${frozenDbPath}. ` +
      `The fixture index may have been modified since it was frozen — refusing to replay.`
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-replay-'));
  const dbPath = path.join(workDir, 'nca.db');
  fs.copyFileSync(frozenDbPath, dbPath);
  // The frozen source may be read-only (it is, deliberately — see manifest);
  // the working copy must stay writable since toolAsk logs query/score rows.
  fs.chmodSync(dbPath, 0o644);

  const registryPath = path.join(workDir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    projects: [
      { name: manifest.index.project, root: manifest.index.root, dbPath, registeredAt: 1780000000 },
    ],
  }, null, 2));

  return {
    dbPath,
    registryPath,
    cleanup: () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

// ─── MCP server: spawn + JSON-RPC over stdio (same transport Claude Code uses) ──

function startServer(distDir, dbPath, registryPath) {
  const mcpEntry = path.join(distDir, 'mcp.js');
  if (!fs.existsSync(mcpEntry)) {
    throw new Error(`mcp.js not found at ${mcpEntry} — build this dist first (npm run build).`);
  }

  const child = spawn('node', [mcpEntry], {
    env: { ...process.env, NCA_DB_PATH: dbPath, NCA_REGISTRY_PATH: registryPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const pending = new Map(); // id -> {resolve, reject}
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || msg.id === null) return;
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg);
    }
  });

  function call(name, args, id) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out waiting for response id=${id} (name=${name}). stderr so far:\n${stderr}`));
        }
      }, 15000);
    });
  }

  function close() {
    rl.close();
    child.stdin.end();
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (!child.killed) child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  return { call, close, getStderr: () => stderr };
}

// ─── Determinism normalization + classifier ────────────────────────────────
// Both now live in src/corpus/nca-ask-result-class.ts (single source of
// truth, shared with the corpus extractor's result_class field). These are
// thin aliases so the rest of this file's existing call sites (classify(),
// normalizeOutput()) don't need to change.

const normalizeOutput = normalizeNcaAskOutput;
const classify = classifyNcaAskResult;

// ─── Report ─────────────────────────────────────────────────────────────────

/**
 * Criterion 3 is decided entirely by Replay A (test/replay/replay-a.js), which
 * isolates NCA regression from synio drift by running two builds against the
 * SAME frozen June index. This just reads that already-generated artifact —
 * it does not run Replay A itself (that needs a second NCA build, --reference-dist,
 * not always at hand when regenerating this report).
 */
function loadReplayAResult() {
  const p = path.join(REPLAY_DIR, 'replay-a-report.json');
  if (!fs.existsSync(p)) {
    throw new Error(`${p} not found — run \`node test/replay/replay-a.js --reference-dist <95d52b4 dist> --capture-golden-baseline\` first (see baseline-manifest.json).`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function buildReport(distDir, results, replayA) {
  const counts = { direct_hit: 0, clean_no_match: 0, noisy_fallback: 0, known_env_error: 0, product_error: 0, out_of_scope: 0 };
  for (const r of results) counts[r.cls]++;

  // The gate is defined over in-scope queries only (task: "el gate se calcula
  // sobre las 58 in-scope"). out_of_scope queries are reported but excluded
  // from every gate denominator and from the pass/fail criteria below.
  const inScope = results.filter(r => r.cls !== 'out_of_scope');
  const outOfScope = results.filter(r => r.cls === 'out_of_scope');
  const inScopeCounts = { direct_hit: 0, clean_no_match: 0, noisy_fallback: 0, known_env_error: 0, product_error: 0 };
  for (const r of inScope) inScopeCounts[r.cls]++;

  const gate = {
    noisy_fallback_zero: { pass: inScopeCounts.noisy_fallback === 0, value: inScopeCounts.noisy_fallback, required: '== 0' },
    product_error_zero: { pass: inScopeCounts.product_error === 0, value: inScopeCounts.product_error, required: '== 0 (known_env_error excluded)' },
    replay_a_no_regression: {
      pass: replayA.gate_pass,
      value: `${replayA.test_direct_hit_count}/${replayA.reference_direct_hit_count}`,
      required: 'direct_hit(build under test) ⊇ direct_hit(95d52b4 reference), 0 content diffs, both against the SAME frozen June-2026 index (test/replay/replay-a-report.json) — regression isolated from synio drift by construction',
      reference_direct_hit_count: replayA.reference_direct_hit_count,
      test_direct_hit_count: replayA.test_direct_hit_count,
      regressions: replayA.regressions,
      golden_diffs_count: replayA.golden_diffs.length,
      historical_reconstruction_limits_count: replayA.historical_reconstruction_limits.length,
    },
    clean_no_match_explicit: {
      pass: inScope.filter(r => r.cls === 'clean_no_match' || r.cls === 'noisy_fallback').every(r => r.cls === 'clean_no_match'),
      value: inScopeCounts.clean_no_match,
      required: 'every non-hit, non-error query is clean_no_match (0 noisy_fallback)',
    },
  };
  gate.overall_pass = Object.values(gate).every(g => g === true || g.pass === true);

  return {
    dist: distDir,
    generated_at: new Date().toISOString(),
    fixture_query_count: results.length,
    in_scope_count: inScope.length,
    out_of_scope_count: outOfScope.length,
    counts,
    in_scope_counts: inScopeCounts,
    gate,
    results: results.map(r => ({
      event_id: r.event_id,
      session_id: r.session_id,
      query: r.query,
      project_arg: r.project_arg,
      cls: r.cls,
      out_of_scope_project: r.outOfScope,
      drift: r.drift ?? undefined,
    })),
  };
}

function toMarkdown(report, goldenDiffs) {
  const lines = [];
  lines.push('# nca_ask replay report — Phase A exit gate');
  lines.push('');
  lines.push(`Dist under test: \`${report.dist}\``);
  lines.push(`Queries replayed: ${report.fixture_query_count} (${report.in_scope_count} in-scope + ${report.out_of_scope_count} out_of_scope, not executed — see below)`);
  lines.push('');
  lines.push('This is the GATE report (Replay B, against the CURRENT September index, for criteria 1/2/4; criterion 3 reads Replay A\'s already-generated result against a separate frozen June index — see test/replay/replay-a.js). For the drift/source-text analysis and historical traceability (informational, no gate), see report-drift.md.');
  lines.push('');
  lines.push('## Counts by class (all 64)');
  lines.push('');
  lines.push('| class | count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(report.counts)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push(`## Gate (computed over the ${report.in_scope_count} in-scope queries only)`);
  lines.push('');
  lines.push('| criterion | required | value | result |');
  lines.push('|---|---|---|---|');
  for (const [k, g] of Object.entries(report.gate)) {
    if (k === 'overall_pass') continue;
    lines.push(`| ${k} | ${g.required} | ${g.value} | ${g.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push(`**Overall gate: ${report.gate.overall_pass ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  if (report.gate.replay_a_no_regression.regressions.length > 0) {
    lines.push('### Replay A regressions (criterion 3)');
    lines.push('');
    for (const r of report.gate.replay_a_no_regression.regressions) {
      lines.push(`- \`${r.event_id}\` (${JSON.stringify(r.query)}): reference=${r.reference_cls}, test=${r.test_cls}`);
    }
    lines.push('');
  }
  if (goldenDiffs && goldenDiffs.length > 0) {
    lines.push('## Golden diffs (direct_hit content changed vs pre-#54 build, on the CURRENT index — informational, not gated; see Replay A for the gated comparison)');
    lines.push('');
    for (const d of goldenDiffs) {
      lines.push(`- \`${d.event_id}\` (${JSON.stringify(d.query)}): ${d.reason}`);
    }
    lines.push('');
  } else {
    lines.push('## Golden diffs (informational, on the CURRENT index)');
    lines.push('');
    lines.push('None — all direct_hit queries with a golden file match byte-for-byte after normalization.');
    lines.push('');
  }
  lines.push('## Out-of-scope project_arg queries (see manifest.queries.caveat_out_of_scope_project_args)');
  lines.push('');
  const outOfScope = report.results.filter(r => r.out_of_scope_project);
  if (outOfScope.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| event_id | query | project_arg | class |');
    lines.push('|---|---|---|---|');
    for (const r of outOfScope) lines.push(`| ${r.event_id} | ${JSON.stringify(r.query)} | ${r.project_arg} | ${r.cls} |`);
  }
  lines.push('');
  lines.push('## All queries');
  lines.push('');
  lines.push('| event_id | class | query |');
  lines.push('|---|---|---|');
  for (const r of report.results) lines.push(`| ${r.event_id} | ${r.cls} | ${JSON.stringify(r.query)} |`);
  lines.push('');
  return lines.join('\n');
}

// ─── Replay B drift report (informational, no gate) ────────────────────────

function toDriftMarkdown(report, historical) {
  const lines = [];
  lines.push('# nca_ask replay — drift report (Replay B, informational, no gate)');
  lines.push('');
  lines.push(`Dist: \`${report.dist}\` — CURRENT (September) index. See report.md for the gated Phase A report; criterion 3 there is decided by Replay A (replay-a-report.json / replay-a.js), not by this file.`);
  lines.push('');

  const allCounts = {};
  for (const h of historical) allCounts[h.cls] = (allCounts[h.cls] || 0) + 1;
  const scoped = historical.filter(h => h.in_scope);
  const scopedCounts = {};
  for (const h of scoped) scopedCounts[h.cls] = (scopedCounts[h.cls] || 0) + 1;
  const baselineHits = scoped.filter(h => h.cls === 'direct_hit');

  lines.push('## Historical baseline (June 2026 live sessions), same classifier');
  lines.push('');
  lines.push(`All 64: ${JSON.stringify(allCounts)}`);
  lines.push('');
  lines.push(`In-scope 58: ${JSON.stringify(scopedCounts)}`);
  lines.push('');
  lines.push(`Historical in-scope direct_hit count: ${baselineHits.length}. See replay-a-report.json for how many of these reproduce against a period-correct (June) index/build pair — this section only traces them against the CURRENT (drifted) index.`);
  lines.push('');
  lines.push('### Traceability: historical in-scope direct_hit -> today\'s replay class (current index)');
  lines.push('');
  lines.push('| event_id | query | replay class today | drift verdict |');
  lines.push('|---|---|---|---|');
  const byId = new Map(report.results.map(r => [r.event_id, r]));
  for (const h of baselineHits) {
    const r = byId.get(h.event_id);
    const verdict = r && r.drift ? r.drift.verdict : 'n/a';
    lines.push(`| ${h.event_id} | ${JSON.stringify(h.query)} | ${r ? r.cls : 'MISSING'} | ${verdict} |`);
  }
  lines.push('');
  lines.push('## Drift analysis (clean_no_match, in-scope only)');
  lines.push('');
  const driftRows = report.results.filter(r => r.drift);
  const driftCounts = { symbol_absent: 0, source_text_present_but_not_retrieved: 0, undeterminable: 0 };
  for (const r of driftRows) driftCounts[r.drift.verdict]++;
  lines.push(`Counts — symbol_absent (drift): ${driftCounts.symbol_absent} · source_text_present_but_not_retrieved: ${driftCounts.source_text_present_but_not_retrieved} · undeterminable: ${driftCounts.undeterminable}`);
  lines.push('');
  lines.push('`source_text_present_but_not_retrieved` means: the candidate token(s) extracted from the query still appear as TEXT in the synio tree at the commit this (current) index was built from, but nca_ask returned no match. It does NOT by itself mean NCA regressed — see replay-a-report.json for the empirical, build-isolated answer on whichever of these were also historical hits.');
  lines.push('');
  lines.push('| event_id | query | candidate(s) | exists in synio@commit | verdict |');
  lines.push('|---|---|---|---|---|');
  for (const r of driftRows) {
    const cands = r.drift.candidates.length > 0
      ? r.drift.candidates.map(c => `${c.token}${c.exists ? ' ✓' : ' ✗'}`).join(', ')
      : '—';
    const anyExists = r.drift.candidates.some(c => c.exists);
    lines.push(`| ${r.event_id} | ${JSON.stringify(r.query)} | ${cands} | ${anyExists ? 'yes' : 'no'} | ${r.drift.verdict} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Replay: run a set of queries against one dist, over the real MCP transport ──

async function replay(distDir, queriesToRun, manifest) {
  const workdir = prepareWorkdir(manifest);
  const server = startServer(distDir, workdir.dbPath, workdir.registryPath);
  const results = [];

  try {
    await new Promise(r => setTimeout(r, 500)); // server init, mirrors AC5

    const calls = queriesToRun.map((q, i) => {
      const args = { query: q.query };
      if (q.project_arg) args.project = q.project_arg;
      return server.call('nca_ask', args, i + 1).then(response => {
        const { cls, detail } = classify(response);
        results.push({ event_id: q.event_id, session_id: q.session_id, query: q.query, project_arg: q.project_arg, cls, detail, outOfScope: false });
      }).catch(err => {
        results.push({ event_id: q.event_id, session_id: q.session_id, query: q.query, project_arg: q.project_arg, cls: 'product_error', detail: `harness error: ${err.message}`, outOfScope: false });
      });
    });

    await Promise.all(calls);
  } finally {
    await server.close();
    workdir.cleanup();
  }

  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const queries = loadQueries();

  // Read the previously-committed report BEFORE regenerating anything below —
  // --check writes the same default path (test/replay/report.json) it compares
  // against, so the snapshot must be captured up front or the comparison would
  // always be against itself.
  let previousCommitted = null;
  if (opts.check) {
    const committedPath = path.join(REPLAY_DIR, 'report.json');
    if (!fs.existsSync(committedPath)) {
      console.error('--check: no committed test/replay/report.json to compare against.');
      process.exit(2);
    }
    previousCommitted = JSON.parse(fs.readFileSync(committedPath, 'utf-8'));
  }

  if (queries.length !== manifest.queries.count) {
    console.error(`FATAL: fixture drift — queries.jsonl has ${queries.length} rows, manifest expects ${manifest.queries.count}.`);
    process.exit(2);
  }

  // A query is in scope iff it targets the frozen index's project root, either
  // implicitly (no project arg -> resolves via NCA_DB_PATH) or explicitly. Any
  // other project arg points at an index this fixture does not freeze (see
  // manifest.queries.caveat_out_of_scope_project_args) — classify it without
  // executing nca_ask at all, so the report never depends on that live state.
  const isOutOfScope = (q) => !!q.project_arg && q.project_arg !== manifest.index.root;
  const inScopeQueries = queries.filter(q => !isOutOfScope(q));
  const outOfScopeQueries = queries.filter(isOutOfScope);

  const results = [];
  for (const q of outOfScopeQueries) {
    results.push({
      event_id: q.event_id,
      session_id: q.session_id,
      query: q.query,
      project_arg: q.project_arg,
      cls: 'out_of_scope',
      detail: `project_arg='${q.project_arg}' is not the frozen index root ('${manifest.index.root}') — not executed; excluded from the gate.`,
      outOfScope: true,
    });
  }

  const inScopeResults = await replay(opts.dist, inScopeQueries, manifest);
  results.push(...inScopeResults);

  // Restore fixture order (Promise.all preserves array order of pushes only if
  // sequential; results were pushed in resolution order, so re-sort by fixture order)
  const byEventId = new Map(results.map(r => [r.event_id, r]));
  const ordered = queries.map(q => byEventId.get(q.event_id));

  // Drift vs regression discrimination (task item 2) — for every in-scope
  // clean_no_match, check whether the query's target still exists in synio at
  // the commit the frozen index was built from.
  for (const r of ordered) {
    if (r.cls === 'clean_no_match' && !r.outOfScope) {
      r.drift = classifyQuery(r.query, manifest.index.root, manifest.index.synio_commit);
    }
  }

  if (opts.captureGolden) {
    fs.mkdirSync(opts.captureGolden, { recursive: true });
    for (const r of ordered) {
      if (r.cls === 'direct_hit') {
        fs.writeFileSync(path.join(opts.captureGolden, `${r.event_id}.txt`), r.detail, 'utf-8');
      }
    }
  }

  // Golden diff (only meaningful when golden/ is populated — i.e. the "new build" run)
  const goldenDir = path.join(FIXTURE_DIR, 'golden');
  const goldenDiffs = [];
  if (fs.existsSync(goldenDir) && !opts.captureGolden) {
    for (const r of ordered) {
      const goldenFile = path.join(goldenDir, `${r.event_id}.txt`);
      if (!fs.existsSync(goldenFile)) continue;
      const golden = fs.readFileSync(goldenFile, 'utf-8');
      if (r.cls !== 'direct_hit') {
        goldenDiffs.push({ event_id: r.event_id, query: r.query, reason: `was direct_hit in golden, now classified ${r.cls}` });
      } else if (r.detail !== golden) {
        goldenDiffs.push({ event_id: r.event_id, query: r.query, reason: 'content differs from golden after normalization' });
      }
    }
  }

  const replayA = loadReplayAResult();
  const report = buildReport(opts.dist, ordered, replayA);
  report.golden_diffs = goldenDiffs;

  const histPath = path.join(FIXTURE_DIR, 'historical-classes.json');
  const historical = fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath, 'utf-8')) : null;

  const jsonPath = `${opts.outPrefix}.json`;
  const mdPath = `${opts.outPrefix}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(mdPath, toMarkdown(report, goldenDiffs), 'utf-8');

  // Replay B drift report — informational, separate from the gate, only
  // written for the default (non --out-prefix, non --check-internal) run.
  if (historical && opts.outPrefix === path.join(REPLAY_DIR, 'report')) {
    const driftReport = { ...report, generated_at: new Date().toISOString() };
    fs.writeFileSync(path.join(REPLAY_DIR, 'report-drift.json'), JSON.stringify(driftReport, null, 2) + '\n', 'utf-8');
    fs.writeFileSync(path.join(REPLAY_DIR, 'report-drift.md'), toDriftMarkdown(driftReport, historical), 'utf-8');
    console.log(`Drift report (informational, no gate) written to ${path.join(REPLAY_DIR, 'report-drift.json')} and .md`);
  }

  console.log(`Report written to ${jsonPath} and ${mdPath}`);
  console.log(`Counts: ${JSON.stringify(report.counts)}`);
  console.log(`Gate overall: ${report.gate.overall_pass ? 'PASS' : 'FAIL'}`);
  if (goldenDiffs.length > 0) {
    console.log(`Golden diffs: ${goldenDiffs.length}`);
  }

  if (opts.check) {
    const committedByEvent = new Map(previousCommitted.results.map(r => [r.event_id, r.cls]));
    const drift = [];
    for (const r of report.results) {
      const prevCls = committedByEvent.get(r.event_id);
      if (prevCls !== undefined && prevCls !== r.cls) {
        drift.push({ event_id: r.event_id, query: r.query, was: prevCls, now: r.cls });
      }
    }
    if (drift.length > 0) {
      console.error(`CLASSIFIER DRIFT on ${drift.length} quer${drift.length === 1 ? 'y' : 'ies'} vs committed report.json:`);
      for (const d of drift) console.error(`  ${d.event_id} (${JSON.stringify(d.query)}): ${d.was} -> ${d.now}`);
      process.exit(1);
    }
    console.log('--check: no classifier drift vs committed report.json.');
    process.exit(0);
  }

  process.exit(report.gate.overall_pass ? 0 : 1);
}

// Exported so other scripts (e.g. test/replay/historical.js) can reuse the exact
// same classification rules against differently-sourced input, without copying
// or re-implementing them. Guarded below so requiring this module never
// triggers main() — only `node test/replay/run.js` does.
module.exports = { classify, normalizeOutput, KNOWN_ENV_ERROR_RE, prepareWorkdir, startServer, replay, loadQueries };

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err.stack || err.message);
    process.exit(2);
  });
}
