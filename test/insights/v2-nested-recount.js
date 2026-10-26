#!/usr/bin/env node
'use strict';
// Independent raw recount of mcp__nca__nca_ask tool_use blocks in nested
// transcripts (<parent>/subagents/*.jsonl). It reads the raw files directly and
// does not use the extractor, its reader or its event code.
//
// Usage: node test/insights/v2-nested-recount.js [--corpus DIR] [--out FILE]
//
// Canonical nested nca_ask count: 16 (16 unique tool_use ids in assistant lines;
// eligible 16; classifiable 16). A legacy count of 17 appeared earlier. Its only
// reproduction is one extra block: a non-assistant api-request-blob line repeating
// an id that already occurs in an assistant line. That is a duplicate id, so the
// legacy 17 is an overcount. Its provenance is not confirmed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const CORPUS = argValue('--corpus', path.join(HOME, 'nca-gate3-snapshot-2026-10-26', 'projects', '-mnt-c-dev-synio'));
const OUT = argValue('--out', path.join(HOME, 'nca-v2-home', 'audit', 'v2-nested-recount.json'));
const PROJECT_ROOT = '/mnt/c/dev/synio';
const SINCE = Date.parse('2026-09-16T08:45:29Z');
const TOOL = 'mcp__nca__nca_ask';
const MIN_EVENTS = 5;

function readLines(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch (err) { out.push(null); }
  }
  return out;
}

function blocksOf(line) {
  const c = line && line.message && line.message.content;
  return Array.isArray(c) ? c : [];
}

// Parent eligibility, restated from the spec: not a smoke/diag name, and at least
// MIN_EVENTS user/assistant lines with a timestamp and cwd equal to the project root.
function parentEligible(parentId) {
  const file = path.join(CORPUS, parentId + '.jsonl');
  if (!fs.existsSync(file)) return 'orphan';
  if (/smoke|diag|test-session|diagnostic/i.test(parentId)) return 'ineligible';
  const n = readLines(file).filter(l => l && (l.type === 'user' || l.type === 'assistant')
    && typeof l.timestamp === 'string' && l.timestamp !== '' && l.cwd === PROJECT_ROOT).length;
  return n >= MIN_EVENTS ? 'eligible' : 'ineligible';
}

function main() {
  const r = {
    corpus: CORPUS,
    nested_files: 0,
    raw_tool_use_blocks: 0,
    raw_unique_tool_use_ids: 0,
    any_line_type_tool_use_blocks: 0,
    any_line_type_unique_tool_use_ids: 0,
    non_assistant_line_blocks: 0,
    non_assistant_line_blocks_duplicating_an_assistant_id: 0,
    non_assistant_line_types: {},
    raw_lines_mentioning_tool_name: 0,
    raw_blocks_missing_id: 0,
    raw_blocks_by_parent_status: { eligible: 0, ineligible: 0, orphan: 0 },
    raw_blocks_in_eligible_parent_not_main_cwd: 0,
    raw_blocks_in_eligible_parent_before_since: 0,
    raw_blocks_in_eligible_parent_without_timestamp: 0,
    eligible: 0,
    eligible_with_paired_result: 0,
    eligible_without_paired_result: 0,
    per_file_nonzero: [],
  };
  const ids = new Set();
  const anyIds = new Set();
  const nonAssistantIds = [];
  const statusCache = new Map();

  for (const parentId of fs.readdirSync(CORPUS)) {
    const dir = path.join(CORPUS, parentId, 'subagents');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    if (!statusCache.has(parentId)) statusCache.set(parentId, parentEligible(parentId));
    const status = statusCache.get(parentId);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      r.nested_files++;
      const lines = readLines(path.join(dir, name));
      const resultIds = new Set();
      for (const l of lines) {
        for (const b of blocksOf(l)) if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultIds.add(b.tool_use_id);
      }
      let fileCount = 0;
      for (const l of lines) {
        if (l === null) continue;
        if (JSON.stringify(l).includes(TOOL)) r.raw_lines_mentioning_tool_name++;
        for (const b of blocksOf(l)) {
          if (!b || b.type !== 'tool_use' || b.name !== TOOL) continue;
          r.any_line_type_tool_use_blocks++;
          if (typeof b.id === 'string') anyIds.add(b.id);
          if (l.type !== 'assistant') {
            r.non_assistant_line_blocks++;
            r.non_assistant_line_types[l.type] = (r.non_assistant_line_types[l.type] || 0) + 1;
            nonAssistantIds.push(b.id);
          }
        }
        if (l.type !== 'assistant') continue;
        for (const b of blocksOf(l)) {
          if (!b || b.type !== 'tool_use' || b.name !== TOOL) continue;
          r.raw_tool_use_blocks++;
          fileCount++;
          if (typeof b.id === 'string') ids.add(b.id); else r.raw_blocks_missing_id++;
          r.raw_blocks_by_parent_status[status]++;
          if (status !== 'eligible') continue;
          const ts = typeof l.timestamp === 'string' ? Date.parse(l.timestamp) : NaN;
          if (Number.isNaN(ts)) { r.raw_blocks_in_eligible_parent_without_timestamp++; continue; }
          if (l.cwd !== PROJECT_ROOT) { r.raw_blocks_in_eligible_parent_not_main_cwd++; continue; }
          if (ts < SINCE) { r.raw_blocks_in_eligible_parent_before_since++; continue; }
          r.eligible++;
          if (typeof b.id === 'string' && resultIds.has(b.id)) r.eligible_with_paired_result++;
          else r.eligible_without_paired_result++;
        }
      }
      if (fileCount > 0) r.per_file_nonzero.push({ parent: parentId, file: name, blocks: fileCount });
    }
  }
  r.raw_unique_tool_use_ids = ids.size;
  r.any_line_type_unique_tool_use_ids = anyIds.size;
  r.non_assistant_line_blocks_duplicating_an_assistant_id = nonAssistantIds.filter(id => ids.has(id)).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r));
  console.log('Output: ' + OUT);
}

main();
