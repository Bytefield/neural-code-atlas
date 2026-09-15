#!/usr/bin/env node
/**
 * Historical classification of the 64 frozen nca_ask queries — what the agent
 * actually received in the live May/June 2026 baseline sessions, run through
 * the exact same classifier as the replay harness (test/replay/run.js:classify),
 * unmodified.
 *
 * Source: raw session transcripts for the synio baseline corpus. These had
 * already rotated out of ~/.claude/projects/ by the time the replay fixture was
 * built (see manifest.json:queries.raw_transcripts_note) and were recovered from
 * a local backup at ~/nca-corpus-backup/-mnt-c-dev-synio/ — external to this
 * repo, same as the frozen index. This script locates, for each of the 64
 * frozen event_ids, the tool_use block that produced it (matched by
 * recomputing the corpus extractor's own deterministic event_id hash — see
 * src/corpus/events.ts:makeEventId — bijectively against every
 * mcp__nca__nca_ask tool_use block in the backup, exactly as was done when
 * queries.jsonl itself was built) and its paired tool_result.
 *
 * Historical tool_result blocks are shaped {content, is_error} (Claude Code's
 * transcript schema), not the {result:{content}} | {error:{message}} JSON-RPC
 * envelope classify() expects — adaptToResponse() below translates one into
 * the other losslessly (same text, same error flag) without altering
 * classify()'s rules at all.
 *
 * Usage: node test/replay/historical.js
 * Writes test/fixtures/replay/historical-classes.json (64 entries).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { classify } = require('./run.js');

const REPLAY_DIR = __dirname;
const FIXTURE_DIR = path.join(REPLAY_DIR, '..', 'fixtures', 'replay');
const BACKUP_DIR = path.join(os.homedir(), 'nca-corpus-backup', '-mnt-c-dev-synio');
const SOURCE_PROJECT = 'synio'; // matches manifest.queries.source_manifest's --project value

function makeEventId(sourceProject, sessionId, timestamp, eventType, disambiguator) {
  // Mirrors src/corpus/events.ts:makeEventId exactly (sha256, first 16 hex chars).
  const s = [sourceProject, sessionId, timestamp, eventType, disambiguator].join('|');
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  }
  return String(content);
}

function adaptToResponse(toolResult) {
  const text = extractText(toolResult.content);
  if (toolResult.is_error) return { error: { message: text } };
  return { result: { content: [{ type: 'text', text }] } };
}

function loadQueries() {
  const file = path.join(FIXTURE_DIR, 'queries.jsonl');
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf-8'));
}

/** Walk every backup transcript once, recomputing event_id for every
 * mcp__nca__nca_ask tool_use block, and index by event_id. Bijective: the
 * same method that built queries.jsonl in the first place (64/64, 0
 * collisions, 0 missing — see manifest.queries.reconstruction_method). */
function indexHistoricalToolUses() {
  if (!fs.existsSync(BACKUP_DIR)) {
    throw new Error(`Backup corpus not found at ${BACKUP_DIR} — historical classification requires it (external to this repo, same as the frozen index).`);
  }
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.jsonl'));
  const toolUses = new Map(); // event_id -> {tool_use_id, session_id, timestamp}
  const toolResults = new Map(); // tool_use_id -> {content, is_error}
  const collisions = [];

  for (const f of files) {
    const fp = path.join(BACKUP_DIR, f);
    const lines = fs.readFileSync(fp, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let d;
      try { d = JSON.parse(trimmed); } catch { continue; }

      if (d.type === 'assistant' && typeof d.timestamp === 'string' && d.message && Array.isArray(d.message.content)) {
        for (const block of d.message.content) {
          if (block && block.type === 'tool_use' && block.name === 'mcp__nca__nca_ask' && block.id) {
            const eventId = makeEventId(SOURCE_PROJECT, d.sessionId, d.timestamp, 'post_tool_use', block.id);
            if (toolUses.has(eventId)) collisions.push(eventId);
            toolUses.set(eventId, { tool_use_id: block.id, session_id: d.sessionId, timestamp: d.timestamp });
          }
        }
      }

      const content = d.message && d.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_result' && block.tool_use_id) {
            toolResults.set(block.tool_use_id, { content: block.content, is_error: !!block.is_error });
          }
        }
      }
    }
  }

  return { toolUses, toolResults, collisions };
}

function main() {
  const manifest = loadManifest();
  const queries = loadQueries();
  const { toolUses, toolResults, collisions } = indexHistoricalToolUses();

  if (collisions.length > 0) {
    console.error(`FATAL: ${collisions.length} event_id collision(s) while indexing the historical corpus — reconstruction is not bijective, refusing to proceed.`);
    process.exit(2);
  }

  const out = [];
  const missing = [];
  for (const q of queries) {
    const tu = toolUses.get(q.event_id);
    if (!tu) {
      missing.push(q.event_id);
      continue;
    }
    const tr = toolResults.get(tu.tool_use_id);
    const inScope = !q.project_arg || q.project_arg === manifest.index.root;

    if (!tr) {
      out.push({
        event_id: q.event_id, session_id: q.session_id, query: q.query, project_arg: q.project_arg,
        in_scope: inScope, cls: 'product_error', detail: 'historical tool_result not found in backup transcript (tool_use present, no paired tool_result)',
      });
      continue;
    }

    const response = adaptToResponse(tr);
    const { cls, detail } = classify(response);
    out.push({ event_id: q.event_id, session_id: q.session_id, query: q.query, project_arg: q.project_arg, in_scope: inScope, cls, detail });
  }

  if (missing.length > 0) {
    console.error(`FATAL: ${missing.length} of ${queries.length} frozen event_ids have no matching historical tool_use in the backup corpus — cannot classify:`);
    for (const m of missing) console.error(`  ${m}`);
    process.exit(2);
  }

  out.sort((a, b) => a.event_id.localeCompare(b.event_id));

  const outPath = path.join(FIXTURE_DIR, 'historical-classes.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');

  const counts = {};
  for (const r of out) counts[r.cls] = (counts[r.cls] || 0) + 1;
  const inScopeCounts = {};
  for (const r of out.filter(r => r.in_scope)) inScopeCounts[r.cls] = (inScopeCounts[r.cls] || 0) + 1;

  console.log(`Wrote ${out.length} entries to ${outPath}`);
  console.log(`All 64: ${JSON.stringify(counts)}`);
  console.log(`In-scope (${out.filter(r => r.in_scope).length}): ${JSON.stringify(inScopeCounts)}`);
}

if (require.main === module) {
  main();
}

module.exports = { makeEventId, adaptToResponse, extractText };
