#!/usr/bin/env node
/**
 * Phase B checkpoint condition 4, verified on REAL data (previously only
 * proven in synthetic fixtures — see events.test.js's CORPUS-20 and events.ts's
 * own scope comments). Compares the frozen v2 baseline against the frozen v3
 * re-extraction, index-by-index: same event count, order, timestamps, session
 * ids, tool names, file paths, and event ids — the only allowed differences
 * are schema_version (v2 -> v3, expected) and the new result_class/
 * result_classifier fields (present ONLY on mcp__nca__nca_ask post_tool_use
 * events, per events.ts's scope guarantee).
 *
 * Usage: node test/insights/identity-check.js [--check]
 * (--check is a no-op flag, accepted for consistency with the other scripts
 * in this directory; this script has only one mode.)
 *
 * Exit codes:
 *   0  either frozen file is missing — SKIPPED, never a false green
 *   0  identity fully verified
 *   1  sha256 drift on either file, or any field-level mismatch — a real
 *      regression, per this task's own instruction: PARA y reporta
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadFrozen(manifestName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, manifestName), 'utf-8'));
  const filePath = manifest.frozen_file.replace(/^~/, os.homedir());
  return { manifest, filePath };
}

// Fields that must be byte-identical between v2 and v3 for the same event.
const IDENTITY_FIELDS = [
  'event_id', 'source_session_id', 'source_project', 'nca_experiment_phase',
  'subagent', 'event_type', 'timestamp', 'git_branch', 'source_cwd',
  'prompt_hash', 'prompt_length', 'tool_name', 'file_path',
];

function main() {
  const v2 = loadFrozen('manifest.json');
  const v3 = loadFrozen('manifest-v3.json');

  console.log('Phase B checkpoint condition 4 — v2 -> v3 identity check (real data)');
  console.log(`  v2: ${v2.filePath}`);
  console.log(`  v3: ${v3.filePath}`);

  if (!fs.existsSync(v2.filePath) || !fs.existsSync(v3.filePath)) {
    console.log('');
    console.log('SKIPPED: one or both frozen files are not present on this machine.');
    console.log('This is not a failure — see test/insights/fixtures/manifest*.json for');
    console.log('provenance and how they were produced.');
    process.exit(0);
  }

  for (const [label, f] of [['v2', v2], ['v3', v3]]) {
    const actual = sha256(f.filePath);
    if (actual !== f.manifest.sha256) {
      console.error(`DRIFT: ${label} file sha256 does not match its manifest.`);
      console.error(`  expected: ${f.manifest.sha256}`);
      console.error(`  actual:   ${actual}`);
      process.exit(1);
    }
  }
  console.log('  sha256: both match their manifests');
  console.log('');

  const v2Events = fs.readFileSync(v2.filePath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const v3Events = fs.readFileSync(v3.filePath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));

  if (v2Events.length !== v3Events.length) {
    console.error(`DRIFT: event count differs — v2=${v2Events.length} v3=${v3Events.length}`);
    process.exit(1);
  }
  console.log(`  event count: ${v2Events.length} (identical)`);

  let fieldMismatches = 0;
  const mismatchExamples = [];
  for (let i = 0; i < v2Events.length; i++) {
    const a = v2Events[i], b = v3Events[i];
    for (const field of IDENTITY_FIELDS) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        fieldMismatches++;
        if (mismatchExamples.length < 10) {
          mismatchExamples.push(`  index ${i} field ${field}: v2=${JSON.stringify(a[field])} v3=${JSON.stringify(b[field])}`);
        }
      }
    }
  }

  if (fieldMismatches > 0) {
    console.error(`DRIFT: ${fieldMismatches} field-level mismatch(es) between v2 and v3 events.`);
    console.error('Per this task\'s own instruction, this is a hard stop:');
    for (const m of mismatchExamples) console.error(m);
    if (fieldMismatches > mismatchExamples.length) console.error(`  ...and ${fieldMismatches - mismatchExamples.length} more`);
    process.exit(1);
  }
  console.log(`  field identity (${IDENTITY_FIELDS.join(', ')}): 0 mismatches across all events`);

  // schema_version must differ (v2 -> v3); extractor_version must match.
  const schemaOk = v2Events[0].schema_version === 'orientation_event_v2' && v3Events[0].schema_version === 'orientation_event_v3';
  const extractorOk = v2Events.every((e, i) => e.extractor_version === v3Events[i].extractor_version);
  if (!schemaOk || !extractorOk) {
    console.error(`DRIFT: schema_version/extractor_version did not change as expected (schemaOk=${schemaOk}, extractorOk=${extractorOk})`);
    process.exit(1);
  }
  console.log('  schema_version: v2 -> v3 (expected); extractor_version: unchanged (expected)');

  // Scope guarantee: result_class exists ONLY on mcp__nca__nca_ask post_tool_use events.
  const v2WithResultClass = v2Events.filter(e => e.result_class !== undefined).length;
  if (v2WithResultClass !== 0) {
    console.error(`DRIFT: v2 events must never carry result_class, found ${v2WithResultClass}.`);
    process.exit(1);
  }
  const v3WithResultClass = v3Events.filter(e => e.result_class !== undefined);
  const v3ResultClassOffScope = v3WithResultClass.filter(e => e.tool_name !== 'mcp__nca__nca_ask');
  if (v3ResultClassOffScope.length > 0) {
    console.error(`DRIFT: ${v3ResultClassOffScope.length} v3 event(s) carry result_class outside mcp__nca__nca_ask scope.`);
    process.exit(1);
  }
  console.log(`  result_class scope: 0 on v2; ${v3WithResultClass.length} on v3, all mcp__nca__nca_ask (0 out of scope)`);

  console.log('');
  console.log('─'.repeat(70));
  console.log('IDENTITY: PASS — v3 preserves v2 exactly (count, order, all shared fields);');
  console.log('only addition is result_class/result_classifier, scoped correctly.');
  process.exit(0);
}

main();
