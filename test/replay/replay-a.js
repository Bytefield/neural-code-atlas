#!/usr/bin/env node
/**
 * Replay A — the Phase A regression gate.
 *
 * Isolates "did NCA's own code regress" from "did synio's code drift" by
 * running the SAME 58 in-scope queries against the SAME frozen index (the
 * June-2026-vintage snapshot in test/fixtures/replay/baseline-manifest.json)
 * under two different NCA builds: the reference build from the end of the
 * baseline window (95d52b4) and the build under test (main by default).
 * Since the index never changes between the two runs, any difference in
 * classification is attributable to NCA's code, not to synio's code having
 * moved on — unlike comparing against the CURRENT (September) index, where
 * drift and regression are inseparable.
 *
 * Also cross-references test/fixtures/replay/historical-classes.json (the
 * REAL June 2026 live-session results): a historical direct_hit that even
 * the reference build misses against the reconstructed index is a
 * reconstruction limit (this specific frozen commit isn't a perfect stand-in
 * for whatever the live index looked like at the exact moment of that
 * session — sessions span the whole May 28 - June 26 window, not one commit)
 * — reported separately, does not gate.
 *
 * Test-side only. Not a product command.
 *
 * Usage:
 *   node test/replay/replay-a.js --reference-dist <path> [--dist <path>]
 *       [--capture-golden-baseline] [--check]
 *
 *   --reference-dist <path>     Dist for the reference build (95d52b4).
 *                                Required — no default, must be built separately
 *                                (see baseline-manifest.json:index.nca_build_used_to_scan).
 *   --dist <path>                Dist for the build under test. Default: <repo>/dist.
 *   --capture-golden-baseline    Write test/fixtures/replay/golden-baseline/<event_id>.txt
 *                                for every reference-build direct_hit. Run once against
 *                                the reference build to populate it.
 *   --check                      Regenerate replay-a-report.json and diff its per-query
 *                                reference_cls/test_cls against the last committed one;
 *                                exit non-zero and print the diff on any change. This is
 *                                run.js --check's counterpart for Replay A's own (June)
 *                                index — together they cover both frozen indices. Needs
 *                                --reference-dist like any other run (the June build isn't
 *                                always at hand, which is why this lives on its own script
 *                                rather than run.js's --check).
 *
 * Writes test/replay/replay-a-report.json (committed artifact; run.js reads it
 * for the main report's third gate criterion).
 */

const fs = require('fs');
const path = require('path');
const { prepareWorkdir, startServer, replay, loadQueries, normalizeOutput } = require('./run.js');

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');
const REPO_ROOT = path.join(REPLAY_DIR, '..', '..');

function parseArgs(argv) {
  const out = { referenceDist: null, dist: path.join(REPO_ROOT, 'dist'), captureGoldenBaseline: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reference-dist') out.referenceDist = path.resolve(argv[++i]);
    else if (argv[i] === '--dist') out.dist = path.resolve(argv[++i]);
    else if (argv[i] === '--capture-golden-baseline') out.captureGoldenBaseline = true;
    else if (argv[i] === '--check') out.check = true;
  }
  return out;
}

function loadBaselineIndexManifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'baseline-manifest.json'), 'utf-8'));
}

function loadHistoricalInScopeHits() {
  const histPath = path.join(FIXTURE_DIR, 'historical-classes.json');
  const hist = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
  return hist.filter(h => h.in_scope && h.cls === 'direct_hit');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.referenceDist) {
    console.error('FATAL: --reference-dist is required (e.g. a build of NCA commit 95d52b4 — see baseline-manifest.json).');
    process.exit(2);
  }

  // Capture the previously-committed report BEFORE regenerating anything below —
  // this script writes the same default path (replay-a-report.json) --check
  // compares against, so the snapshot must be taken up front (same pattern as
  // run.js's --check).
  let previousCommitted = null;
  if (opts.check) {
    const committedPath = path.join(REPLAY_DIR, 'replay-a-report.json');
    if (!fs.existsSync(committedPath)) {
      console.error('--check: no committed test/replay/replay-a-report.json to compare against.');
      process.exit(2);
    }
    previousCommitted = JSON.parse(fs.readFileSync(committedPath, 'utf-8'));
  }

  const baselineManifest = loadBaselineIndexManifest();
  const allQueries = loadQueries();
  // Same in-scope definition as run.js's main(): project_arg unset or equal to
  // the frozen index's own root. Uses the BASELINE index's root, which happens
  // to be the same synio path as the September index's, so this yields the
  // identical 58 in-scope / 6 out-of-scope split.
  const inScopeQueries = allQueries.filter(q => !q.project_arg || q.project_arg === baselineManifest.index.root);

  console.log(`Replaying ${inScopeQueries.length} in-scope queries against the frozen June index...`);
  console.log(`  reference build: ${opts.referenceDist}`);
  console.log(`  build under test: ${opts.dist}`);

  const referenceResults = await replay(opts.referenceDist, inScopeQueries, baselineManifest);
  const testResults = await replay(opts.dist, inScopeQueries, baselineManifest);

  const refByEvent = new Map(referenceResults.map(r => [r.event_id, r]));
  const testByEvent = new Map(testResults.map(r => [r.event_id, r]));

  const referenceHitIds = new Set(referenceResults.filter(r => r.cls === 'direct_hit').map(r => r.event_id));
  const testHitIds = new Set(testResults.filter(r => r.cls === 'direct_hit').map(r => r.event_id));

  if (opts.captureGoldenBaseline) {
    const goldenDir = path.join(FIXTURE_DIR, 'golden-baseline');
    fs.mkdirSync(goldenDir, { recursive: true });
    for (const r of referenceResults) {
      if (r.cls === 'direct_hit') fs.writeFileSync(path.join(goldenDir, `${r.event_id}.txt`), r.detail, 'utf-8');
    }
    console.log(`Captured ${referenceHitIds.size} golden-baseline direct_hit files to ${goldenDir}`);
  }

  // direct_hit(test) ⊇ direct_hit(reference): every reference hit must still
  // be a hit under test, with byte-identical (normalized) content.
  const regressions = [];
  const goldenDiffs = [];
  for (const id of referenceHitIds) {
    const ref = refByEvent.get(id);
    const test = testByEvent.get(id);
    if (!testHitIds.has(id)) {
      regressions.push({ event_id: id, query: ref.query, reference_cls: 'direct_hit', test_cls: test ? test.cls : 'MISSING' });
      continue;
    }
    if (normalizeOutput(test.detail) !== normalizeOutput(ref.detail)) {
      goldenDiffs.push({ event_id: id, query: ref.query, reason: 'direct_hit content differs between reference and test build' });
    }
  }

  // Cross-reference the REAL June live-session hits against what the
  // reconstructed index + reference build can reproduce.
  const historicalHits = loadHistoricalInScopeHits();
  const reconstructionLimits = [];
  for (const h of historicalHits) {
    if (!referenceHitIds.has(h.event_id)) {
      reconstructionLimits.push({
        event_id: h.event_id,
        query: h.query,
        reference_cls: refByEvent.get(h.event_id) ? refByEvent.get(h.event_id).cls : 'MISSING',
        note: 'the real June session found this, but the reference build (95d52b4) against the RECONSTRUCTED baseline index (synio@13c01e51) does not — a limit of using one fixed commit to stand in for a session window spanning 2026-05-28 to 2026-06-26, not an NCA regression.',
      });
    }
  }

  const gatePass = regressions.length === 0 && goldenDiffs.length === 0;

  const report = {
    generated_at: new Date().toISOString(),
    reference_dist: opts.referenceDist,
    test_dist: opts.dist,
    baseline_index: {
      synio_commit: baselineManifest.index.synio_commit,
      sha256: baselineManifest.index.storage.sha256,
    },
    in_scope_count: inScopeQueries.length,
    reference_direct_hit_count: referenceHitIds.size,
    test_direct_hit_count: testHitIds.size,
    regressions,
    golden_diffs: goldenDiffs,
    historical_reconstruction_limits: reconstructionLimits,
    gate_pass: gatePass,
    results: inScopeQueries.map(q => ({
      event_id: q.event_id,
      query: q.query,
      reference_cls: refByEvent.get(q.event_id) ? refByEvent.get(q.event_id).cls : 'MISSING',
      test_cls: testByEvent.get(q.event_id) ? testByEvent.get(q.event_id).cls : 'MISSING',
    })),
  };

  const outPath = path.join(REPLAY_DIR, 'replay-a-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  console.log(`Reference (95d52b4-style) direct_hit: ${referenceHitIds.size}`);
  console.log(`Test (${path.basename(opts.dist)}) direct_hit: ${testHitIds.size}`);
  console.log(`Regressions: ${regressions.length}`);
  console.log(`Golden diffs: ${goldenDiffs.length}`);
  console.log(`Historical reconstruction limits: ${reconstructionLimits.length}`);
  console.log(`Gate: ${gatePass ? 'PASS' : 'FAIL'}`);
  console.log(`Wrote ${outPath}`);

  if (opts.check) {
    const prevByEvent = new Map(previousCommitted.results.map(r => [r.event_id, r]));
    const drift = [];
    for (const r of report.results) {
      const prev = prevByEvent.get(r.event_id);
      if (prev && (prev.reference_cls !== r.reference_cls || prev.test_cls !== r.test_cls)) {
        drift.push({ event_id: r.event_id, query: r.query, was: prev, now: r });
      }
    }
    if (drift.length > 0) {
      console.error(`REPLAY A DRIFT on ${drift.length} quer${drift.length === 1 ? 'y' : 'ies'} vs committed replay-a-report.json:`);
      for (const d of drift) {
        console.error(`  ${d.event_id} (${JSON.stringify(d.query)}): reference ${d.was.reference_cls}->${d.now.reference_cls}, test ${d.was.test_cls}->${d.now.test_cls}`);
      }
      process.exit(1);
    }
    console.log('--check: no drift vs committed replay-a-report.json.');
    process.exit(0);
  }

  process.exit(gatePass ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(2);
});
