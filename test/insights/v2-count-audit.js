#!/usr/bin/env node
'use strict';
// Count-only denominator harness for the v2 corpus fidelity audit.
// Prints absolute counts per rule and per set. Never prints anything derived
// from a count pair. Does not import engine code.
//
// Usage: node test/insights/v2-count-audit.js [--baseline FILE] [--flagon FILE] [--out FILE] [--label TEXT]
//
// Oracle 1 baseline: ~/.nca/replay/synio-baseline-events-v3.jsonl (default).
// The spec originally named ~/.nca/metrics/synio/orientation-events.jsonl; that
// file lacks result_class, so NCA_ASK cannot match there. Recorded as erratum 2
// in the decision ledger. Re-run with --baseline to see the original mismatch.
//
// ORACLE_CHECK lines compare against fixed integers only, nothing else.
//
// Source check (no division between counts in this file), run standalone:
//   node test/insights/v2-count-audit.source-check.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASELINE = argValue('--baseline', path.join(HOME, '.nca', 'replay', 'synio-baseline-events-v3.jsonl'));
const FLAGON = argValue('--flagon', path.join(HOME, 'nca-v2-home', '.nca', 'metrics', 'synio-v2', 'orientation-events.jsonl'));
const OUT = argValue('--out', path.join(HOME, 'nca-v2-home', 'audit', 'v2-count-audit.json'));
const LABEL = argValue('--label', null);

const VAULT_MARKER = 'obsidian_vault';
const TOP_N = 5;
const MERGE_GAP_MS = 10000;
const NCA_ASK = 'mcp__nca__nca_ask';

function load(file) {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Deterministic order: timestamp, then event_id.
function ordered(events) {
  return [...events].sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.event_id, b.event_id));
}

// REREAD denominator. The top-5 selection is global over the set being evaluated
// (it crosses sessions); it is not applied per parent session.
function rereadCounts(events) {
  const tools = events.filter(e => e.event_type === 'post_tool_use');
  const reads = tools.filter(e => e.tool_name === 'Read' && typeof e.file_path === 'string');
  const vault = reads.filter(e => e.file_path.toLowerCase().includes(VAULT_MARKER));
  const nonVault = reads.filter(e => !e.file_path.toLowerCase().includes(VAULT_MARKER));
  const perFile = new Map();
  for (const e of nonVault) perFile.set(e.file_path, (perFile.get(e.file_path) || 0) + 1);
  const topFiles = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(x => x[0]);
  const topSet = new Set(topFiles);
  const top = nonVault.filter(e => topSet.has(e.file_path));
  return {
    events_considered: events.length,
    excluded_not_post_tool_use: events.length - tools.length,
    excluded_not_read_or_no_file_path: tools.length - reads.length,
    reads: reads.length,
    excluded_vault: vault.length,
    excluded_top5: top.length,
    top5_files: topFiles,
    final_n: nonVault.length - top.length,
  };
}

// SEARCH_FIRST denominator. Prompts are grouped by source_session_id; the 10 s
// merge only joins consecutive prompts of the same source_session_id. A nested
// transcript has its own source_session_id, so nested prompts never merge into
// the parent's prompts, and no merge crosses parent sessions.
function searchFirstCounts(events) {
  const bySession = new Map();
  for (const e of ordered(events)) {
    if (e.event_type !== 'user_prompt_submit') continue;
    if (!bySession.has(e.source_session_id)) bySession.set(e.source_session_id, []);
    bySession.get(e.source_session_id).push(e);
  }
  let prompts = 0;
  let merged = 0;
  for (const list of bySession.values()) {
    prompts += list.length;
    for (let i = 1; i < list.length; i++) {
      const gap = new Date(list[i].timestamp).getTime() - new Date(list[i - 1].timestamp).getTime();
      if (gap <= MERGE_GAP_MS) merged++;
    }
  }
  const sessionIds = new Set(events.map(e => e.source_session_id));
  return {
    events_considered: events.length,
    excluded_not_user_prompt_submit: events.length - prompts,
    sessions_in_set: sessionIds.size,
    sessions_with_prompts: bySession.size,
    prompts,
    excluded_merged_within_10s: merged,
    final_n: prompts - merged,
  };
}

function ncaAskCounts(events) {
  const calls = events.filter(e => e.event_type === 'post_tool_use' && e.tool_name === NCA_ASK);
  const classifiable = calls.filter(e => e.result_class !== undefined);
  return {
    events_considered: events.length,
    total: calls.length,
    classifiable: classifiable.length,
    unclassifiable: calls.length - classifiable.length,
  };
}

function countSet(events) {
  return { reread: rereadCounts(events), search_first: searchFirstCounts(events), nca_ask: ncaAskCounts(events) };
}

const ORACLE_1 = {
  reread: { final_n: 735, excluded_vault: 80, excluded_top5: 62 },
  search_first: { final_n: 688, excluded_merged_within_10s: 168 },
  nca_ask: { total: 64, classifiable: 64, unclassifiable: 0 },
};
const ORACLE_2 = {
  reread: { final_n: 57, reads: 97, excluded_vault: 9, excluded_top5: 31 },
  search_first: { final_n: 777, prompts: 895, excluded_merged_within_10s: 118 },
  nca_ask: { total: 0, classifiable: 0, unclassifiable: 0 },
};

function oracleDiffs(counts, expected) {
  const out = [];
  for (const rule of Object.keys(expected)) {
    for (const key of Object.keys(expected[rule])) {
      if (counts[rule][key] !== expected[rule][key]) {
        out.push({ rule, key, expected: expected[rule][key], got: counts[rule][key] });
      }
    }
  }
  return out;
}

// Additivity: main + nested versus the independently computed combined set.
const ADDITIVE_FIELDS = {
  reread: ['events_considered', 'reads', 'excluded_vault', 'excluded_top5', 'final_n'],
  search_first: ['events_considered', 'prompts', 'excluded_merged_within_10s', 'final_n'],
  nca_ask: ['total', 'classifiable', 'unclassifiable'],
};
function additivityMismatches(main, nested, combined) {
  const out = [];
  for (const rule of Object.keys(ADDITIVE_FIELDS)) {
    for (const key of ADDITIVE_FIELDS[rule]) {
      const sum = main[rule][key] + nested[rule][key];
      if (sum !== combined[rule][key]) {
        out.push({ rule, key, main: main[rule][key], nested: nested[rule][key], main_plus_nested: sum, combined: combined[rule][key] });
      }
    }
  }
  return out;
}

function main() {
  const result = { label: LABEL, baseline_file: BASELINE, flagon_file: FLAGON };
  const base = load(BASELINE);
  const flag = load(FLAGON);

  result.oracle1_counts = countSet(base);
  result.oracle1_diffs = oracleDiffs(result.oracle1_counts, ORACLE_1);
  const mainOnly = flag.filter(e => e.subagent === false);
  const nestedOnly = flag.filter(e => e.subagent === true);
  result.flagon_events = flag.length;
  result.flagon_subagent_neither_true_nor_false = flag.length - mainOnly.length - nestedOnly.length;
  result.oracle2_counts = countSet(mainOnly);
  result.oracle2_diffs = oracleDiffs(result.oracle2_counts, ORACLE_2);

  console.log('ORACLE_CHECK oracle1 (frozen baseline) ' + (result.oracle1_diffs.length === 0 ? 'ok' : 'fail'));
  console.log(JSON.stringify(result.oracle1_counts));
  if (result.oracle1_diffs.length) console.log('oracle1 diffs: ' + JSON.stringify(result.oracle1_diffs));
  console.log('ORACLE_CHECK oracle2 (flag-on, subagent=false) ' + (result.oracle2_diffs.length === 0 ? 'ok' : 'fail'));
  console.log(JSON.stringify(result.oracle2_counts));
  if (result.oracle2_diffs.length) console.log('oracle2 diffs: ' + JSON.stringify(result.oracle2_diffs));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (result.oracle1_diffs.length || result.oracle2_diffs.length) {
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log('v2 sets not reported (oracle check failed). Output: ' + OUT);
    process.exit(1);
  }

  result.v2_main_only = countSet(mainOnly);
  result.v2_nested_only = countSet(nestedOnly);
  result.v2_combined = countSet(flag);
  result.additivity_mismatches = additivityMismatches(result.v2_main_only, result.v2_nested_only, result.v2_combined);
  for (const name of ['v2_main_only', 'v2_nested_only', 'v2_combined']) {
    console.log(name + ': ' + JSON.stringify(result[name]));
  }
  console.log('additivity mismatches: ' + JSON.stringify(result.additivity_mismatches));
  const topMain = new Set(result.v2_main_only.reread.top5_files);
  const topCombined = result.v2_combined.reread.top5_files;
  result.top5_cause = {
    note: 'top-5 files are re-selected inside each set, so the excluded files differ between sets',
    combined_top5_also_in_main_top5: topCombined.filter(f => topMain.has(f)).length,
    combined_top5_not_in_main_top5: topCombined.filter(f => !topMain.has(f)).length,
  };
  console.log('top5 cause: ' + JSON.stringify(result.top5_cause));
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('Output: ' + OUT);
}

main();
