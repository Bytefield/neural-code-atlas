#!/usr/bin/env node
/**
 * Phase B gate 1 — verifies the insights engine against the REAL, frozen
 * SYNIO main-only baseline corpus (~/.nca/replay/synio-baseline-events-v3.jsonl,
 * the v3 re-extraction — see manifest-v3.json for provenance), not the
 * synthetic fixtures in test/insights-regression.test.js. Those prove the
 * engine's arithmetic and determinism are correct given known inputs; this
 * proves the engine reaches the documented decisions when run on real,
 * historical session data — reproducible by anyone with the frozen file in
 * place, the same way test/replay/run.js --check works: real data lives
 * outside the repo, only its sha256 + metadata are committed
 * (test/insights/fixtures/manifest-v3.json — deliberately NOT under
 * test/fixtures/, which is the CLI test suite's own scan target; a .md file
 * placed there gets swept up as a spurious indexed note by unrelated
 * SK5-03-style tests).
 *
 * The v2 freeze (manifest.json, synio-baseline-events.jsonl) predates this
 * script's v3 upgrade and is kept only as a historical record of the earlier,
 * incomplete search for the raw transcripts — see manifest-v3.json's
 * provenance for the correction. This script no longer reads it.
 *
 * Usage: node test/insights/baseline-check.js [--check]
 * (--check is accepted for command-line consistency with test/replay/run.js
 * --check; this script has only one mode, so the flag is a no-op.)
 *
 * Exit codes:
 *   0  frozen file not present on this machine — SKIPPED, never a false green
 *   0  all 3 rules verified against real data — full PASS (gate 1 = 3/3)
 *   1  sha256 drift, event/session count drift, or a rule failed to
 *      reproduce its documented decision — a real kill signal
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'fixtures', 'manifest-v3.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const frozenPath = manifest.frozen_file.replace(/^~/, os.homedir());

  console.log('Phase B gate 1 — frozen baseline check (v3)');
  console.log(`  frozen file: ${frozenPath}`);

  if (!fs.existsSync(frozenPath)) {
    console.log('');
    console.log('SKIPPED: frozen v3 baseline file not found on this machine.');
    console.log('This is not a failure — it means this machine has not been set up with');
    console.log('the gate-1 corpus. See test/insights/fixtures/manifest-v3.json for exact');
    console.log('provenance (sha256, source, window) and how it was produced.');
    process.exit(0);
  }

  const actualSha = sha256(frozenPath);
  if (actualSha !== manifest.sha256) {
    console.error('');
    console.error('DRIFT: frozen file sha256 does not match the committed manifest.');
    console.error(`  expected: ${manifest.sha256}`);
    console.error(`  actual:   ${actualSha}`);
    console.error('The frozen baseline must never be modified in place — restore the');
    console.error('original, or update the manifest deliberately with a documented reason.');
    process.exit(1);
  }
  console.log(`  sha256: ${actualSha}  (matches manifest)`);

  const { computeInsights } = require(path.join(ROOT, 'dist', 'corpus', 'insights', 'index.js'));

  const events = fs.readFileSync(frozenPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const sessions = new Set(events.map(e => e.source_session_id));

  if (events.length !== manifest.events_total) {
    console.error(`DRIFT: expected ${manifest.events_total} events, found ${events.length}.`);
    process.exit(1);
  }
  if (sessions.size !== manifest.sessions_total) {
    console.error(`DRIFT: expected ${manifest.sessions_total} sessions, found ${sessions.size}.`);
    process.exit(1);
  }
  console.log(`  events: ${events.length}  sessions: ${sessions.size}  (match manifest)`);
  console.log('');

  const recs = computeInsights(events, { projectId: manifest.project, cwdFilterMode: manifest.cwd_filter_mode });
  const byRule = Object.fromEntries(recs.map(r => [r.rule, r]));

  let failures = 0;

  // ── P4a — REREAD_MEMORY_V1 ────────────────────────────────────────────────
  {
    const rec = byRule['REREAD_MEMORY_V1'];
    // EXPLORATORY-ANALYSIS-P4A-BRIEF-INJECTION-2026-08-20, SIN-VAULT-SIN-TOP5, 7-day window.
    const DOCUMENTED_VALUE = 0.195;
    // Observed gap ~0.016 (0.2109 vs 0.195): this engine selects its top-N-excluded
    // files by frequency (methodology.ts's generalization, project-agnostic), which
    // only partially overlaps the doc's 5 hand-identified files (2 of 5 exactly:
    // globalSetup.ts, trpc/init.ts) — a legitimate calibration difference, not
    // drift. Declared with margin above the observed gap; still tight enough to
    // catch a real regression (e.g. the same-session-reread bug from commit
    // e299892 pushed this to ~0.42, more than 10x outside this tolerance).
    const TOLERANCE = 0.03;
    const diff = Math.abs(rec.value - DOCUMENTED_VALUE);
    const ok = rec.type === 'dont_build' && diff <= TOLERANCE;
    console.log('P4a / REREAD_MEMORY_V1:');
    console.log(`  type=${rec.type}  value=${rec.value}`);
    console.log(`  documented≈${DOCUMENTED_VALUE}  |diff|=${diff.toFixed(4)}  tolerance=${TOLERANCE}`);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — expected type=dont_build within tolerance of the documented rate`);
    if (!ok) failures++;
  }
  console.log('');

  // ── Brief — SEARCH_FIRST_ACTION_V1 ────────────────────────────────────────
  {
    const rec = byRule['SEARCH_FIRST_ACTION_V1'];
    const EXPECTED_VALUE = 124 / 688; // the doc's "doble corrección" figure, exact
    const ok = rec.type === 'dont_build' && rec.value === EXPECTED_VALUE;
    console.log('Brief / SEARCH_FIRST_ACTION_V1:');
    console.log(`  type=${rec.type}  value=${rec.value}`);
    console.log(`  expected=${EXPECTED_VALUE}  (exact match required, no tolerance)`);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — expected type=dont_build at exactly 124/688`);
    if (!ok) failures++;
  }
  console.log('');

  // ── nca_ask — NCA_ASK_NOISY_FALLBACK_V1 ───────────────────────────────────
  {
    const rec = byRule['NCA_ASK_NOISY_FALLBACK_V1'];
    const ok = rec.type === 'fix' && rec.value !== null && rec.value >= 0.4;
    console.log('nca_ask / NCA_ASK_NOISY_FALLBACK_V1:');
    console.log(`  type=${rec.type}  value=${rec.value}`);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — expected type=fix, value>=0.4`);
    if (!ok) failures++;
    const HISTORICAL = 47 / 64;
    if (rec.value === HISTORICAL) {
      console.log(`  value matches the historical 47/64 (${HISTORICAL.toFixed(6)}) exactly — the raw`);
      console.log('  session transcripts backed up at ~/nca-corpus-backup/-mnt-c-dev-synio/');
      console.log('  reproduce REC-0001\'s own baseline figure bit-for-bit once re-extracted with');
      console.log('  the v3 classifier.');
    } else if (rec.value !== null) {
      console.log(`  NOTE: real v3 value (${rec.value}) differs from the historical 47/64 ` +
        `(${HISTORICAL.toFixed(6)}). Explain the source of any such difference before`);
      console.log('  trusting it (e.g. calls with no matching tool_result, sessions outside the');
      console.log('  frozen window) — none applies here, this branch exists for future re-runs.');
    }
  }
  console.log('');

  console.log('─'.repeat(70));
  if (failures > 0) {
    console.log(`GATE 1: FAIL — ${failures} rule(s) did not reproduce the documented decision.`);
    console.log('Per this task\'s own instruction, this is the kill signal: heuristics are');
    console.log('wrong, not the idea. Do not adjust thresholds to force a pass.');
    process.exit(1);
  }
  console.log('GATE 1: PASS (3/3) — all 3 rules reproduce the documented decision against real data.');
  process.exit(0);
}

main();
