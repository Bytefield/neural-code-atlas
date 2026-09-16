/**
 * Corpus insights engine tests (Phase B v1).
 * Consumed by test/run.js via: require('./insights.test.js')(test, assert)
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
      source_project: 'test-project',
      nca_experiment_phase: 'baseline',
      subagent: false,
      event_type: 'post_tool_use',
      timestamp: '2026-06-01T10:00:00.000Z',
      git_branch: 'main',
      source_cwd: '/test/project',
    },
    overrides,
  );
}

function ts(isoBase, offsetMs) {
  return new Date(new Date(isoBase).getTime() + offsetMs).toISOString();
}

module.exports = function runInsightsTests(test, assert) {
  const m = loadModules();
  const {
    computeRereadRate,
    computeSearchFirstActionRate,
    computeNcaAskNoisyFallbackRate,
    computeInsights,
    REREAD_MEMORY_V1,
    SEARCH_FIRST_ACTION_V1,
    NCA_ASK_NOISY_FALLBACK_V1,
  } = m.insights;

  // ── INSIGHTS-1: reread rate basic + 7-day window ─────────────────────────────

  test('INSIGHTS-1a computeRereadRate counts a cross-session reread within 7 days', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      mkEvent({ source_session_id: 'sess-1', tool_name: 'Read', file_path: '/proj/src/a.ts', timestamp: ts(base, 0) }),
      mkEvent({ source_session_id: 'sess-2', tool_name: 'Read', file_path: '/proj/src/a.ts', timestamp: ts(base, 60_000) }),
    ];
    // topNExcluded:0 isolates the reread/window logic from the top-N exclusion
    // (covered separately by 1d) — with only 1 distinct file, top-5 would swallow it.
    const result = computeRereadRate(events, { topNExcluded: 0 });
    assert(result.denominator === 2, `Expected denominator=2, got ${result.denominator}`);
    assert(result.numerator === 1, `Expected numerator=1, got ${result.numerator}`);
    assert(result.value === 0.5, `Expected value=0.5, got ${result.value}`);
  });

  test('INSIGHTS-1a2 computeRereadRate does NOT count a same-session repeat read as a reread', () => {
    // P4a's premise is cross-session persistence — a file read twice in the SAME
    // session is already in that session's context; not what session memory targets.
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      mkEvent({ source_session_id: 'sess-1', tool_name: 'Read', file_path: '/proj/src/a.ts', timestamp: ts(base, 0) }),
      mkEvent({ source_session_id: 'sess-1', tool_name: 'Read', file_path: '/proj/src/a.ts', timestamp: ts(base, 60_000) }),
    ];
    const result = computeRereadRate(events, { topNExcluded: 0 });
    assert(result.numerator === 0, `Same-session repeat must not count as reread, got numerator=${result.numerator}`);
    assert(result.value === 0, `Expected value=0, got ${result.value}`);
  });

  test('INSIGHTS-1b computeRereadRate does not count a cross-session reread past the 7-day window', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const events = [
      mkEvent({ source_session_id: 'sess-1', tool_name: 'Read', file_path: '/proj/src/a.ts', timestamp: ts(base, 0) }),
      mkEvent({ source_session_id: 'sess-2', tool_name: 'Read', file_path: '/proj/src/a.ts', timestamp: ts(base, eightDaysMs) }),
    ];
    const result = computeRereadRate(events, { topNExcluded: 0 });
    assert(result.numerator === 0, `Expected numerator=0 (reread outside 7d window), got ${result.numerator}`);
    assert(result.value === 0, `Expected value=0, got ${result.value}`);
  });

  test('INSIGHTS-1c computeRereadRate excludes vault paths from the population entirely', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      mkEvent({ tool_name: 'Read', file_path: '/home/x/Papi_Obsidian_Vault/notes.md', timestamp: ts(base, 0) }),
      mkEvent({ tool_name: 'Read', file_path: '/home/x/Papi_Obsidian_Vault/notes.md', timestamp: ts(base, 1000) }),
    ];
    const result = computeRereadRate(events);
    assert(result.denominator === 0, `Vault-only reads must be fully excluded, got denominator=${result.denominator}`);
    assert(result.excludedVaultReads === 2, `Expected excludedVaultReads=2, got ${result.excludedVaultReads}`);
  });

  test('INSIGHTS-1d computeRereadRate excludes the top-N most-read files', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [];
    // /proj/hot.ts read 5 times (rapid, all within 7d) -> would dominate the raw rate.
    for (let i = 0; i < 5; i++) {
      events.push(mkEvent({ tool_name: 'Read', file_path: '/proj/hot.ts', timestamp: ts(base, i * 1000) }));
    }
    // A single, non-repeated file.
    events.push(mkEvent({ tool_name: 'Read', file_path: '/proj/once.ts', timestamp: ts(base, 100_000) }));
    const result = computeRereadRate(events, { topNExcluded: 1 });
    assert(result.excludedTopNFiles.includes('/proj/hot.ts'),
      `Expected /proj/hot.ts excluded as top-1, got ${JSON.stringify(result.excludedTopNFiles)}`);
    assert(result.denominator === 1, `Expected denominator=1 after excluding hot.ts, got ${result.denominator}`);
    assert(result.numerator === 0, `once.ts has no reread, expected numerator=0, got ${result.numerator}`);
  });

  test('INSIGHTS-1e computeRereadRate returns null value with zero denominator (no Read events)', () => {
    const result = computeRereadRate([]);
    assert(result.value === null, `Expected value=null for empty input, got ${result.value}`);
    assert(result.denominator === 0, `Expected denominator=0, got ${result.denominator}`);
  });

  // ── INSIGHTS-2: search-first-action classification + dequeuing ──────────────

  test('INSIGHTS-2a computeSearchFirstActionRate classifies SEARCH/EXEC/DIRECT/NONE first actions', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      // Session with SEARCH first (Read)
      mkEvent({ source_session_id: 'search-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h1', prompt_length: 5 }),
      mkEvent({ source_session_id: 'search-sess', event_type: 'post_tool_use', tool_name: 'Read', timestamp: ts(base, 1000) }),
      // Session with EXEC first (Bash)
      mkEvent({ source_session_id: 'exec-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h2', prompt_length: 5 }),
      mkEvent({ source_session_id: 'exec-sess', event_type: 'post_tool_use', tool_name: 'Bash', timestamp: ts(base, 1000) }),
      // Session with DIRECT first (Edit)
      mkEvent({ source_session_id: 'direct-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h3', prompt_length: 5 }),
      mkEvent({ source_session_id: 'direct-sess', event_type: 'post_tool_use', tool_name: 'Edit', timestamp: ts(base, 1000) }),
      // Session with NONE (no tool before session ends)
      mkEvent({ source_session_id: 'none-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h4', prompt_length: 5 }),
    ];
    const result = computeSearchFirstActionRate(events);
    assert(result.denominator === 4, `Expected 4 segments, got ${result.denominator}`);
    assert(result.buckets.SEARCH === 1, `Expected 1 SEARCH, got ${result.buckets.SEARCH}`);
    assert(result.buckets.EXEC === 1, `Expected 1 EXEC, got ${result.buckets.EXEC}`);
    assert(result.buckets.DIRECT === 1, `Expected 1 DIRECT, got ${result.buckets.DIRECT}`);
    assert(result.buckets.NONE === 1, `Expected 1 NONE, got ${result.buckets.NONE}`);
    assert(result.value === 0.25, `Expected value=0.25, got ${result.value}`);
  });

  test('INSIGHTS-2b computeSearchFirstActionRate reclassifies mcp__nca__nca_ask as SEARCH', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      mkEvent({ source_session_id: 'nca-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h', prompt_length: 5 }),
      mkEvent({ source_session_id: 'nca-sess', event_type: 'post_tool_use', tool_name: 'mcp__nca__nca_ask', timestamp: ts(base, 1000) }),
    ];
    const result = computeSearchFirstActionRate(events);
    assert(result.buckets.SEARCH === 1, `Expected nca_ask reclassified as SEARCH, got buckets=${JSON.stringify(result.buckets)}`);
  });

  test('INSIGHTS-2c computeSearchFirstActionRate merges prompts queued within 10s (no spurious NONE)', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      // Two prompts 2s apart (queued) in the same session; only ONE Read tool call follows the second.
      mkEvent({ source_session_id: 'q-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h1', prompt_length: 5 }),
      mkEvent({ source_session_id: 'q-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 2000), prompt_hash: 'h2', prompt_length: 5 }),
      mkEvent({ source_session_id: 'q-sess', event_type: 'post_tool_use', tool_name: 'Read', timestamp: ts(base, 3000) }),
    ];
    const result = computeSearchFirstActionRate(events);
    assert(result.queuedPromptsMerged === 1, `Expected 1 merged prompt, got ${result.queuedPromptsMerged}`);
    assert(result.denominator === 1, `Expected 1 surviving segment (not 2), got ${result.denominator}`);
    assert(result.buckets.SEARCH === 1, `Expected the merged segment to be SEARCH, got ${JSON.stringify(result.buckets)}`);
    assert(result.buckets.NONE === 0, `Queued prompt must not produce a spurious NONE, got NONE=${result.buckets.NONE}`);
  });

  test('INSIGHTS-2d computeSearchFirstActionRate does not merge prompts more than 10s apart', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [
      mkEvent({ source_session_id: 'far-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 0), prompt_hash: 'h1', prompt_length: 5 }),
      mkEvent({ source_session_id: 'far-sess', event_type: 'user_prompt_submit', timestamp: ts(base, 15_000), prompt_hash: 'h2', prompt_length: 5 }),
    ];
    const result = computeSearchFirstActionRate(events);
    assert(result.queuedPromptsMerged === 0, `Expected 0 merged prompts, got ${result.queuedPromptsMerged}`);
    assert(result.denominator === 2, `Expected 2 independent segments, got ${result.denominator}`);
    assert(result.buckets.NONE === 2, `Both segments have no tool call, expected NONE=2, got ${result.buckets.NONE}`);
  });

  // ── INSIGHTS-3: nca_ask noisy_fallback rate + v2/unclassifiable tolerance ───

  test('INSIGHTS-3a computeNcaAskNoisyFallbackRate computes noisy_fallback share of classifiable calls', () => {
    const events = [
      mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'noisy_fallback', result_classifier: 'NCA_ASK_RESULT_V1' }),
      mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'noisy_fallback', result_classifier: 'NCA_ASK_RESULT_V1' }),
      mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'direct_hit', result_classifier: 'NCA_ASK_RESULT_V1' }),
      mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'clean_no_match', result_classifier: 'NCA_ASK_RESULT_V1' }),
    ];
    const result = computeNcaAskNoisyFallbackRate(events);
    assert(result.denominator === 4, `Expected denominator=4, got ${result.denominator}`);
    assert(result.numerator === 2, `Expected numerator=2, got ${result.numerator}`);
    assert(result.value === 0.5, `Expected value=0.5, got ${result.value}`);
    assert(result.unclassifiableCalls === 0, `Expected 0 unclassifiable, got ${result.unclassifiableCalls}`);
  });

  test('INSIGHTS-3b computeNcaAskNoisyFallbackRate treats events without result_class as unclassifiable, not zero', () => {
    // Simulates v2-era events (predate result_class) mixed with v3 events.
    const events = [
      mkEvent({ tool_name: 'mcp__nca__nca_ask' }), // no result_class — v2-shaped
      mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'noisy_fallback', result_classifier: 'NCA_ASK_RESULT_V1' }),
    ];
    const result = computeNcaAskNoisyFallbackRate(events);
    assert(result.totalCallsSeen === 2, `Expected totalCallsSeen=2, got ${result.totalCallsSeen}`);
    assert(result.denominator === 1, `Expected denominator=1 (only the classifiable call), got ${result.denominator}`);
    assert(result.unclassifiableCalls === 1, `Expected unclassifiableCalls=1, got ${result.unclassifiableCalls}`);
    assert(result.value === 1, `Expected value=1 (1/1 classifiable is noisy_fallback), got ${result.value}`);
  });

  test('INSIGHTS-3c computeNcaAskNoisyFallbackRate returns null value with zero classifiable calls', () => {
    const events = [mkEvent({ tool_name: 'mcp__nca__nca_ask' })]; // no result_class at all
    const result = computeNcaAskNoisyFallbackRate(events);
    assert(result.value === null, `Expected value=null, got ${result.value}`);
    assert(result.denominator === 0, `Expected denominator=0, got ${result.denominator}`);
    assert(result.totalCallsSeen === 1, `Expected totalCallsSeen=1, got ${result.totalCallsSeen}`);
  });

  // ── INSIGHTS-4: engine — recommendation objects, schema, thresholds, INSUFFICIENT_EVIDENCE ──

  test('INSIGHTS-4a computeInsights emits 4 recommendation objects with the frozen schema fields', () => {
    const recs = computeInsights([], { projectId: 'test-project', cwdFilterMode: 'main-only' });
    assert(recs.length === 4, `Expected 4 recommendations, got ${recs.length}`);
    const requiredFields = [
      'vocabulary_version', 'project_id', 'id', 'type', 'target', 'finding', 'task_class',
      'value', 'threshold', 'rule', 'evidence', 'evidence_level', 'scope', 'expected_effect',
      'metric_to_remeasure', 'expires_when', 'methodology_version',
    ];
    for (const rec of recs) {
      for (const field of requiredFields) {
        assert(field in rec, `Recommendation ${rec.id} missing field ${field}`);
      }
      assert(rec.scope === 'test-project/main-only', `Expected scope=test-project/main-only, got ${rec.scope}`);
      assert(rec.methodology_version === '1', `Expected methodology_version=1, got ${rec.methodology_version}`);
    }
  });

  test('INSIGHTS-4b computeInsights: empty corpus yields insufficient_evidence for all 3 computed rules', () => {
    const recs = computeInsights([], { projectId: 'test-project' });
    const byRule = Object.fromEntries(recs.map(r => [r.rule, r]));
    assert(byRule[REREAD_MEMORY_V1.rule].type === 'insufficient_evidence',
      `Expected REREAD insufficient_evidence, got ${byRule[REREAD_MEMORY_V1.rule].type}`);
    assert(byRule[SEARCH_FIRST_ACTION_V1.rule].type === 'insufficient_evidence',
      `Expected SEARCH_FIRST insufficient_evidence, got ${byRule[SEARCH_FIRST_ACTION_V1.rule].type}`);
    assert(byRule[NCA_ASK_NOISY_FALLBACK_V1.rule].type === 'insufficient_evidence',
      `Expected NCA_ASK insufficient_evidence, got ${byRule[NCA_ASK_NOISY_FALLBACK_V1.rule].type}`);
    for (const rec of recs) {
      if (rec.rule === 'NCA_ASK_RECALL_GAP_V1') continue; // static, not event-derived
      assert(rec.evidence_level === 'INSUFFICIENT', `Expected evidence_level=INSUFFICIENT, got ${rec.evidence_level}`);
    }
  });

  test('INSIGHTS-4c computeInsights: nca_ask events without result_class (v2-shaped) do not fall back to a hardcoded historical value', () => {
    // Condition 5: events present, but none carry result_class -> insufficient_evidence,
    // never inferred and never REC-0001's historical 47/64 figure.
    const events = [
      mkEvent({ tool_name: 'mcp__nca__nca_ask', schema_version: 'orientation_event_v2' }),
      mkEvent({ tool_name: 'mcp__nca__nca_ask', schema_version: 'orientation_event_v2' }),
    ];
    const recs = computeInsights(events, { projectId: 'test-project' });
    const ncaAskRec = recs.find(r => r.rule === NCA_ASK_NOISY_FALLBACK_V1.rule);
    assert(ncaAskRec.type === 'insufficient_evidence',
      `Expected insufficient_evidence for result_class-less events, got ${ncaAskRec.type}`);
    assert(ncaAskRec.value === null, `Expected value=null, got ${ncaAskRec.value}`);
    assert(ncaAskRec.value !== 0.734375, 'Must never silently emit the historical 47/64 figure');
  });

  test('INSIGHTS-4d computeInsights: nca_ask type=fix when noisy_fallback rate crosses 0.4', () => {
    const events = [];
    // 5 noisy_fallback, 2 direct_hit -> 5/7 ≈ 0.714 >= 0.4
    for (let i = 0; i < 5; i++) {
      events.push(mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'noisy_fallback', result_classifier: 'NCA_ASK_RESULT_V1' }));
    }
    for (let i = 0; i < 2; i++) {
      events.push(mkEvent({ tool_name: 'mcp__nca__nca_ask', result_class: 'direct_hit', result_classifier: 'NCA_ASK_RESULT_V1' }));
    }
    const recs = computeInsights(events, { projectId: 'test-project' });
    const ncaAskRec = recs.find(r => r.rule === NCA_ASK_NOISY_FALLBACK_V1.rule);
    assert(ncaAskRec.type === 'fix', `Expected type=fix, got ${ncaAskRec.type}`);
    assert(ncaAskRec.value >= 0.4, `Expected value>=0.4, got ${ncaAskRec.value}`);
  });

  test('INSIGHTS-4e computeInsights: reread type=dont_build when below threshold (P4a-shaped fixture)', () => {
    const base = '2026-06-01T00:00:00.000Z';
    const events = [];
    // 10 distinct files, each read once -> reread rate 0 -> well below 0.4 threshold.
    for (let i = 0; i < 10; i++) {
      events.push(mkEvent({ tool_name: 'Read', file_path: `/proj/file${i}.ts`, timestamp: ts(base, i * 1000) }));
    }
    const recs = computeInsights(events, { projectId: 'test-project' });
    const rereadRec = recs.find(r => r.rule === REREAD_MEMORY_V1.rule);
    assert(rereadRec.type === 'dont_build', `Expected type=dont_build, got ${rereadRec.type}`);
  });

  test('INSIGHTS-4f computeInsights always includes the non-gating recall-gap finding', () => {
    const recs = computeInsights([], { projectId: 'test-project' });
    const recallRec = recs.find(r => r.rule === 'NCA_ASK_RECALL_GAP_V1');
    assert(recallRec !== undefined, 'Expected the recall-gap finding to always be present');
    assert(recallRec.type === 'no_intervention', `Expected type=no_intervention, got ${recallRec.type}`);
  });
};
