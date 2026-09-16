/**
 * Corpus insights — regression fixtures (Phase B exit gate, roadmap §Phase B).
 *
 * The three known decisions must reproduce from their documented historical
 * population characteristics, without steering the engine's thresholds:
 *   P4a session memory   -> DONT_BUILD
 *   Brief injection      -> DONT_BUILD
 *   nca_ask               -> FIX
 *
 * Fixtures here are SYNTHETIC, built to the exact ratios documented in
 * EXPLORATORY-ANALYSIS-P4A-BRIEF-INJECTION-2026-08-20 (P4a/Brief) and this
 * task's condition 6 (nca_ask, "histórico corregido 47/64") — not copies of
 * real corpus data (consistent with every other fixture in this repo:
 * test/fixtures/corpus/*.jsonl are hand-authored, not live-corpus dumps; the
 * real frozen synio baseline lives only under the user's ~/.nca/metrics/,
 * never committed, and was used only for informal validation — see the
 * previous two commits' messages for the exact real-data reproduction
 * figures this synthetic construction was checked against).
 *
 * Consumed by test/run.js via: require('./insights-regression.test.js')(test, assert)
 */

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadModules() {
  return {
    insights: require(path.join(ROOT, 'dist', 'corpus', 'insights', 'index.js')),
  };
}

let seq = 0;
function mkEvent(overrides) {
  seq++;
  return Object.assign(
    {
      event_id: 'ev-' + seq,
      schema_version: 'orientation_event_v3',
      extractor_version: '0.1.0',
      source: 'claude_corpus',
      source_session_id: 's1',
      source_project: 'synio',
      nca_experiment_phase: 'baseline',
      subagent: false,
      event_type: 'post_tool_use',
      timestamp: '2026-06-01T10:00:00.000Z',
      git_branch: 'main',
      source_cwd: '/mnt/c/dev/synio',
    },
    overrides,
  );
}

// ── P4a fixture: 145 cross-session rereads out of 743 scoped reads (19.5%) ──
//
// 145 files read in exactly 2 sessions 1 day apart (within the 7-day window):
// each contributes 1 reread + 2 reads. 453 files read in exactly 1 session:
// each contributes 0 reread + 1 read. 145*2 + 453 = 743; reread = 145.
// topNExcluded:0 isolates this from the top-N exclusion feature (covered by
// its own unit test, INSIGHTS-1d) — every read here is already "in scope".
function buildP4aFixture() {
  const events = [];
  const base = '2026-06-01T00:00:00.000Z';
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 145; i++) {
    const file = `/mnt/c/dev/synio/src/reread-${i}.ts`;
    events.push(mkEvent({
      source_session_id: `p4a-sess-${i}-a`,
      tool_name: 'Read',
      file_path: file,
      timestamp: new Date(new Date(base).getTime() + i * 1000).toISOString(),
    }));
    events.push(mkEvent({
      source_session_id: `p4a-sess-${i}-b`,
      tool_name: 'Read',
      file_path: file,
      timestamp: new Date(new Date(base).getTime() + i * 1000 + dayMs).toISOString(),
    }));
  }
  for (let i = 0; i < 453; i++) {
    events.push(mkEvent({
      source_session_id: `p4a-single-${i}`,
      tool_name: 'Read',
      file_path: `/mnt/c/dev/synio/src/single-${i}.ts`,
      timestamp: new Date(new Date(base).getTime() + 10_000_000 + i * 1000).toISOString(),
    }));
  }
  return events;
}

// ── Brief fixture: 124 SEARCH-first segments out of 688 total (18.0%) ──
//
// Each segment is its own session with a single prompt and (for SEARCH
// segments) one Read call. Queued-prompt merging and nca_* reclassification
// are already unit-tested in isolation (INSIGHTS-2b/2c/2d) — this fixture
// exercises the end-to-end ratio/threshold path, not the segmentation
// mechanics a second time.
function buildBriefFixture() {
  const events = [];
  const base = '2026-06-02T00:00:00.000Z';
  for (let i = 0; i < 124; i++) {
    const sess = `brief-search-${i}`;
    const promptTs = new Date(new Date(base).getTime() + i * 100_000).toISOString();
    events.push(mkEvent({ source_session_id: sess, event_type: 'user_prompt_submit', timestamp: promptTs, prompt_hash: 'h' + i, prompt_length: 10 }));
    events.push(mkEvent({
      source_session_id: sess,
      tool_name: 'Read',
      file_path: `/mnt/c/dev/synio/src/f${i}.ts`,
      timestamp: new Date(new Date(promptTs).getTime() + 1000).toISOString(),
    }));
  }
  for (let i = 0; i < 564; i++) {
    const sess = `brief-exec-${i}`;
    const promptTs = new Date(new Date(base).getTime() + 20_000_000 + i * 100_000).toISOString();
    events.push(mkEvent({ source_session_id: sess, event_type: 'user_prompt_submit', timestamp: promptTs, prompt_hash: 'g' + i, prompt_length: 10 }));
    events.push(mkEvent({
      source_session_id: sess,
      tool_name: 'Bash',
      timestamp: new Date(new Date(promptTs).getTime() + 1000).toISOString(),
    }));
  }
  return events;
}

// Parameterized nca_ask fixture: `noisy` noisy_fallback calls + (`total` - `noisy`)
// direct_hit calls.
function buildNcaAskRuleset(noisy, total) {
  const events = [];
  for (let i = 0; i < noisy; i++) {
    events.push(mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'noisy_fallback', result_classifier: 'NCA_ASK_RESULT_V1' }));
  }
  for (let i = 0; i < total - noisy; i++) {
    events.push(mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'direct_hit', result_classifier: 'NCA_ASK_RESULT_V1' }));
  }
  return events;
}

// nca_ask fixture: 47 noisy_fallback out of 64 classifiable calls (73.4%).
// Matches this task's own "histórico corregido 47/64 noisy_fallback" framing —
// FIXTURE-3 below proves historical reproduction. The NCA-ASK-RULESET tests
// (A/B/C further down) use buildNcaAskRuleset directly at OTHER ratios to prove
// the heuristic generalizes across the threshold, not just at this one point.
function buildNcaAskFixture() {
  return buildNcaAskRuleset(47, 64);
}

module.exports = function runInsightsRegressionTests(test, assert) {
  const m = loadModules();
  const { computeInsights, REREAD_MEMORY_V1, SEARCH_FIRST_ACTION_V1, NCA_ASK_NOISY_FALLBACK_V1 } = m.insights;

  // ── FIXTURE-1: P4a session memory -> DONT_BUILD ──────────────────────────────

  test('FIXTURE-1 P4a (REREAD_MEMORY_V1) reproduces DONT_BUILD at the documented ~19.5% rate', () => {
    const events = buildP4aFixture();
    const recs = computeInsights(events, { projectId: 'synio', cwdFilterMode: 'main-only', reread: { topNExcluded: 0 } });
    const rec = recs.find(r => r.rule === REREAD_MEMORY_V1.rule);
    assert(Math.abs(rec.value - 0.1952) < 0.001, `Expected value≈0.1952, got ${rec.value}`);
    assert(rec.type === 'dont_build', `Expected type=dont_build, got ${rec.type}`);
    assert(rec.evidence_level === 'EVIDENCE_STRONG', `Expected EVIDENCE_STRONG (n=743), got ${rec.evidence_level}`);
  });

  // ── FIXTURE-2: Brief injection -> DONT_BUILD ─────────────────────────────────

  test('FIXTURE-2 Brief (SEARCH_FIRST_ACTION_V1) reproduces DONT_BUILD at the documented 18.0% rate', () => {
    const events = buildBriefFixture();
    const recs = computeInsights(events, { projectId: 'synio', cwdFilterMode: 'main-only' });
    const rec = recs.find(r => r.rule === SEARCH_FIRST_ACTION_V1.rule);
    assert(Math.abs(rec.value - 0.18023255813953487) < 0.0001, `Expected value≈0.1802, got ${rec.value}`);
    assert(rec.type === 'dont_build', `Expected type=dont_build, got ${rec.type}`);
    assert(rec.evidence_level === 'EVIDENCE_STRONG', `Expected EVIDENCE_STRONG (n=688), got ${rec.evidence_level}`);
  });

  // ── FIXTURE-3: nca_ask -> FIX (matches this task's own "47/64" framing) ─────

  test('FIXTURE-3 nca_ask (NCA_ASK_NOISY_FALLBACK_V1) reproduces FIX at 47/64 noisy_fallback', () => {
    const events = buildNcaAskFixture();
    const recs = computeInsights(events, { projectId: 'synio', cwdFilterMode: 'main-only' });
    const rec = recs.find(r => r.rule === NCA_ASK_NOISY_FALLBACK_V1.rule);
    assert(rec.value === 47 / 64, `Expected value=47/64, got ${rec.value}`);
    assert(rec.value >= 0.4, `Expected value>=0.4 (condition 6's assertion), got ${rec.value}`);
    assert(rec.type === 'fix', `Expected type=fix, got ${rec.type}`);
    assert(rec.evidence_level === 'EVIDENCE_MODERATE', `Expected EVIDENCE_MODERATE (n=64), got ${rec.evidence_level}`);
  });

  // ── FIXTURE-4: all three together reproduce the exit gate in one run ────────

  test('FIXTURE-4 exit gate: P4a/Brief/nca_ask reproduce DONT_BUILD/DONT_BUILD/FIX in a single computeInsights call', () => {
    const events = [...buildP4aFixture(), ...buildBriefFixture(), ...buildNcaAskFixture()];
    const recs = computeInsights(events, { projectId: 'synio', cwdFilterMode: 'main-only', reread: { topNExcluded: 0 } });
    const byRule = Object.fromEntries(recs.map(r => [r.rule, r]));
    assert(byRule[REREAD_MEMORY_V1.rule].type === 'dont_build', 'P4a must reproduce DONT_BUILD');
    assert(byRule[SEARCH_FIRST_ACTION_V1.rule].type === 'dont_build', 'Brief must reproduce DONT_BUILD');
    assert(byRule[NCA_ASK_NOISY_FALLBACK_V1.rule].type === 'fix', 'nca_ask must reproduce FIX');
  });

  // ── NCA-ASK-RULESET A/B/C: the heuristic itself, not the historical figure ──
  //
  // FIXTURE-3 proves the rule reproduces the one known historical value (47/64).
  // These prove the rule's threshold LOGIC generalizes correctly at OTHER
  // ratios that were never observed historically — a rule that only happened
  // to work at 47/64 (e.g. by coincidence or overfitting) would fail these.

  test('NCA-ASK-RULESET-A 30/50 (60%) crosses the 0.4 threshold -> fix', () => {
    const events = buildNcaAskRuleset(30, 50);
    const recs = computeInsights(events, { projectId: 'synio', cwdFilterMode: 'main-only' });
    const rec = recs.find(r => r.rule === NCA_ASK_NOISY_FALLBACK_V1.rule);
    assert(rec.value === 0.6, `Expected value=0.6, got ${rec.value}`);
    assert(rec.type === 'fix', `Expected type=fix, got ${rec.type}`);
  });

  test('NCA-ASK-RULESET-B 10/50 (20%) stays under the 0.4 threshold -> no_intervention', () => {
    const events = buildNcaAskRuleset(10, 50);
    const recs = computeInsights(events, { projectId: 'synio', cwdFilterMode: 'main-only' });
    const rec = recs.find(r => r.rule === NCA_ASK_NOISY_FALLBACK_V1.rule);
    assert(rec.value === 0.2, `Expected value=0.2, got ${rec.value}`);
    assert(rec.type === 'no_intervention', `Expected type=no_intervention, got ${rec.type}`);
  });

  test('NCA-ASK-RULESET-C 0 calls -> insufficient_evidence, never a fabricated value', () => {
    const recs = computeInsights([], { projectId: 'synio', cwdFilterMode: 'main-only' });
    const rec = recs.find(r => r.rule === NCA_ASK_NOISY_FALLBACK_V1.rule);
    assert(rec.value === null, `Expected value=null, got ${rec.value}`);
    assert(rec.type === 'insufficient_evidence', `Expected type=insufficient_evidence, got ${rec.type}`);
  });

  // ── ANTI-HARDCODING GUARD: no rule may emit a value it didn't derive ────────
  //
  // A rule that returns a fixed constant regardless of input (like the removed
  // NCA_ASK_RECALL_GAP_V1, which hardcoded value:26) cannot possibly report
  // value=null on zero input events — only a value genuinely computed FROM the
  // events can naturally be absent when there are none. This is a generic
  // guard: it does not name any rule, so it also catches a future rule added
  // to the engine without checking each one individually.

  test('ANTI-HARDCODING every rule reports value=null on zero input events', () => {
    const recs = computeInsights([], { projectId: 'synio', cwdFilterMode: 'main-only' });
    assert(recs.length > 0, 'Expected at least one recommendation to check');
    for (const rec of recs) {
      assert(rec.value === null,
        `Rule ${rec.rule} reported value=${JSON.stringify(rec.value)} on zero input events — ` +
        `a genuinely derived value must be null/absent when there is nothing to derive it from. ` +
        `A non-null value here means this rule is hardcoding a constant instead of computing it.`);
      assert(rec.type === 'insufficient_evidence',
        `Rule ${rec.rule} reported type=${rec.type} on zero input events, expected insufficient_evidence.`);
    }
  });

  // ── DETERMINISM: computeInsights is byte-identical across repeated runs ─────

  test('DETERMINISM computeInsights produces byte-identical JSON across repeated runs on the same input', () => {
    const events = [...buildP4aFixture(), ...buildBriefFixture(), ...buildNcaAskFixture()];
    const opts = { projectId: 'synio', cwdFilterMode: 'main-only', reread: { topNExcluded: 0 } };
    const run1 = JSON.stringify(computeInsights(events, opts));
    const run2 = JSON.stringify(computeInsights([...events], opts)); // fresh array, same content
    assert(run1 === run2, 'computeInsights must be deterministic (byte-identical) for identical input events');
  });
};
