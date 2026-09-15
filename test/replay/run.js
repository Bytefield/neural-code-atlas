#!/usr/bin/env node
/**
 * Frozen nca_ask replay harness — Phase A exit gate.
 *
 * Replays the 64 nca_ask calls from the SYNIO Phase 0 baseline corpus against a
 * frozen SYNIO index, through the real MCP stdio transport (same path Claude Code
 * itself uses), and classifies every response deterministically. See
 * test/fixtures/replay/manifest.json for the full fixture description, the
 * classifier rules, and known caveats.
 *
 * Test-side only. Not a product command — there is no `nca replay` anywhere in src/.
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
 *                          with the normalized output. Used once, against the
 *                          pre-fix build, to populate test/fixtures/replay/golden/.
 *   --check                Regenerate the report and diff it against the last
 *                          committed test/replay/report.json; exit non-zero (and
 *                          print the diff) if the classifier's per-query result
 *                          changed for any query in the frozen fixture. This is
 *                          the regression test for this harness (task item 8) —
 *                          run it as its own step, not part of test/run.js, since
 *                          it spawns a real child process and is slow relative to
 *                          that suite.
 *   --compare-dist <path>  Directory containing an mcp.js from an earlier NCA
 *                          build (e.g. the last commit at/before the baseline
 *                          window's end). For every in-scope clean_no_match query
 *                          whose drift analysis says symbol_present_but_missed,
 *                          re-runs that exact query against this build (same
 *                          frozen index) and records whether it found a match —
 *                          this is the empirical drift-vs-regression test
 *                          (task: "ejecuta la misma query contra el build del
 *                          final de la ventana baseline").
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

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dist: path.join(REPO_ROOT, 'dist'), outPrefix: path.join(REPLAY_DIR, 'report'), captureGolden: null, check: false, compareDist: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') out.dist = path.resolve(argv[++i]);
    else if (argv[i] === '--out-prefix') out.outPrefix = path.resolve(argv[++i]);
    else if (argv[i] === '--capture-golden') out.captureGolden = path.resolve(argv[++i]);
    else if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--compare-dist') out.compareDist = path.resolve(argv[++i]);
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

// ─── Determinism normalization (see manifest.harness.determinism_normalization) ─

function normalizeOutput(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\|t:\d+/g, '|t:<TS>')
    .replace(/Index is \d+ days old/g, 'Index is <DAYS> days old');
}

// ─── Classifier (rules mirrored in manifest.json:classifier — keep in sync) ─────

const KNOWN_ENV_ERROR_RE = /NCA schema version mismatch|schema_version \(\d+\) is newer than this build supports|No NCA index found/;

function classify(response) {
  if (!response) {
    return { cls: 'product_error', detail: 'no response received' };
  }
  if (response.error) {
    const message = response.error.message ?? '';
    if (KNOWN_ENV_ERROR_RE.test(message)) {
      return { cls: 'known_env_error', detail: normalizeOutput(message) };
    }
    return { cls: 'product_error', detail: normalizeOutput(message) };
  }
  const text = response.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    return { cls: 'product_error', detail: `malformed success response: ${JSON.stringify(response).slice(0, 300)}` };
  }
  const norm = normalizeOutput(text);
  const isNoMatch = /no matches for '/.test(norm);
  if (!isNoMatch) {
    return { cls: 'direct_hit', detail: norm };
  }
  const hasFlowContent = norm.includes('[F]') || /#[^\s[]+\[/.test(norm);
  return { cls: hasFlowContent ? 'noisy_fallback' : 'clean_no_match', detail: norm };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function buildReport(distDir, results) {
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
    direct_hit_at_least_12: { pass: inScopeCounts.direct_hit >= 12, value: inScopeCounts.direct_hit, required: '>= 12' },
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
  if (goldenDiffs && goldenDiffs.length > 0) {
    lines.push('## Golden diffs (direct_hit content changed vs pre-fix build)');
    lines.push('');
    for (const d of goldenDiffs) {
      lines.push(`- \`${d.event_id}\` (${JSON.stringify(d.query)}): ${d.reason}`);
    }
    lines.push('');
  } else {
    lines.push('## Golden diffs');
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
  lines.push('## Drift vs regression (clean_no_match, in-scope only)');
  lines.push('');
  const driftRows = report.results.filter(r => r.drift);
  const driftCounts = { symbol_absent: 0, symbol_present_but_missed: 0, undeterminable: 0 };
  for (const r of driftRows) driftCounts[r.drift.verdict]++;
  lines.push(`Counts — symbol_absent (drift): ${driftCounts.symbol_absent} · symbol_present_but_missed: ${driftCounts.symbol_present_but_missed} · undeterminable: ${driftCounts.undeterminable}`);
  lines.push('');
  lines.push('| event_id | query | candidate(s) | exists in synio@commit | verdict | regression check |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of driftRows) {
    const cands = r.drift.candidates.length > 0
      ? r.drift.candidates.map(c => `${c.token}${c.exists ? ' ✓' : ' ✗'}`).join(', ')
      : '—';
    const anyExists = r.drift.candidates.some(c => c.exists);
    const rc = r.drift.regression_check
      ? (r.drift.regression_check.regression_confirmed
          ? `**REGRESSION** (compare build: ${r.drift.regression_check.compare_cls})`
          : `not a regression (compare build: ${r.drift.regression_check.compare_cls})`)
      : (r.drift.verdict === 'symbol_present_but_missed' ? 'not checked' : 'n/a');
    lines.push(`| ${r.event_id} | ${JSON.stringify(r.query)} | ${cands} | ${anyExists ? 'yes' : 'no'} | ${r.drift.verdict} | ${rc} |`);
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

  // Empirical regression check (task item 2, final paragraph): for every
  // symbol_present_but_missed candidate, replay the SAME query against an
  // earlier NCA build (the one passed via --compare-dist) against the SAME
  // frozen index, and compare classes. A flip (earlier build found it, this
  // one doesn't) is a confirmed regression; identical behavior on both builds
  // means the miss predates (or is unrelated to) anything between the two.
  if (opts.compareDist) {
    const candidates = ordered.filter(r => r.drift && r.drift.verdict === 'symbol_present_but_missed');
    if (candidates.length > 0) {
      const compareQueries = candidates.map(r => ({ event_id: r.event_id, session_id: r.session_id, query: r.query, project_arg: r.project_arg }));
      const compareResults = await replay(opts.compareDist, compareQueries, manifest);
      const compareByEvent = new Map(compareResults.map(c => [c.event_id, c]));
      for (const r of candidates) {
        const cmp = compareByEvent.get(r.event_id);
        r.drift.regression_check = {
          compare_dist: opts.compareDist,
          compare_cls: cmp ? cmp.cls : 'no_response',
          regression_confirmed: !!cmp && cmp.cls === 'direct_hit' && r.cls !== 'direct_hit',
        };
      }
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

  const report = buildReport(opts.dist, ordered);
  report.golden_diffs = goldenDiffs;

  const jsonPath = `${opts.outPrefix}.json`;
  const mdPath = `${opts.outPrefix}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(mdPath, toMarkdown(report, goldenDiffs), 'utf-8');

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

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(2);
});
