#!/usr/bin/env node

/**
 * NCA Stop Hook
 *
 * Emits a one-line summary of the relevant tool activity in the turn that just
 * ended, then advances the turn boundary (last_stop_at) in the session file.
 *
 * Input JSON (stdin): { session_id, cwd, ... }
 *
 * Output (stdout): at most one line, e.g.
 *   [NCA turn: 2 briefs, 3 grep (2 after-brief, 1 blocked), 4 read]
 *
 * Only nca brief, Grep, Glob and Read count toward the line. Edit/Write and
 * generic Bash are intentionally excluded — the line is about navigation.
 *
 * Robustness:
 * - mode 'off' → exit 0, no stdout.
 * - No session file / no relevant events → exit 0, no stdout.
 * - Timeout: 200ms hard cap. Any error → exit 0 silently + .nca/hook.log.
 * - A hook must never break the Claude Code session.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMode } from './lib/mode.js';
import {
  SessionFile,
  ToolEvent,
  now,
  sessionsDir,
  sessionPath,
  acquireLock,
  releaseLock,
  logError,
  isBriefEvent,
} from './lib/session.js';

interface HookInput {
  session_id: string;
  cwd: string;
}

/**
 * Events belonging to the turn that just ended: everything logged after the
 * previous turn boundary. With no boundary yet, the whole session is the turn.
 */
function turnEvents(session: SessionFile): ToolEvent[] {
  const since = session.last_stop_at;
  if (!since) return session.events;
  return session.events.filter((e) => e.ts > since);
}

/**
 * Build the summary line, or '' if the turn had no relevant navigation.
 * Grep and Glob are grouped under "grep"; after-brief/blocked detail is only
 * shown when at least one is non-zero.
 */
function buildSummary(events: ToolEvent[]): string {
  const briefs = events.filter(isBriefEvent).length;
  const grep = events.filter((e) => e.tool === 'Grep' || e.tool === 'Glob');
  const grepCount = grep.length;
  const afterBrief = grep.filter((e) => e.fallback_after_brief).length;
  const blocked = grep.filter((e) => e.blocked).length;
  const reads = events.filter((e) => e.tool === 'Read').length;

  const segments: string[] = [];
  if (briefs > 0) segments.push(`${briefs} brief${briefs === 1 ? '' : 's'}`);
  if (grepCount > 0) {
    const detail =
      afterBrief > 0 || blocked > 0 ? ` (${afterBrief} after-brief, ${blocked} blocked)` : '';
    segments.push(`${grepCount} grep${detail}`);
  }
  if (reads > 0) segments.push(`${reads} read`);

  if (segments.length === 0) return '';
  return `[NCA turn: ${segments.join(', ')}]`;
}

function main(): void {
  const startTime = Date.now();
  const timeout = 200; // ms

  try {
    // Mode gate first — never touch disk if disabled.
    if (getMode() === 'off') process.exit(0);

    let input: HookInput;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf-8'));
    } catch (err) {
      logError(process.cwd(), `Stop stdin parse error: ${String(err).slice(0, 100)}`);
      process.exit(0);
    }

    const { session_id, cwd } = input;
    if (!session_id || !cwd) {
      logError(cwd || '.', 'Stop missing session_id/cwd');
      process.exit(0);
    }

    const sPath = sessionPath(cwd, session_id);
    if (!fs.existsSync(sPath)) process.exit(0); // nothing logged this session

    const lockPath = path.join(sessionsDir(cwd), `.lock-${session_id}`);
    if (!acquireLock(lockPath, timeout - (Date.now() - startTime))) {
      logError(cwd, `Stop lock timeout for session ${session_id}`);
      process.exit(0);
    }

    let summary = '';
    try {
      // Read fresh inside the lock so we never race the PostToolUse writer.
      let session: SessionFile;
      try {
        session = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
      } catch {
        logError(cwd, `Stop failed to parse session ${session_id}`);
        process.exit(0);
      }

      summary = buildSummary(turnEvents(session));

      // Advance the turn boundary regardless of whether a line was emitted, so
      // the next turn does not recount these events.
      session.last_stop_at = now();
      try {
        fs.writeFileSync(sPath, JSON.stringify(session, null, 2), 'utf-8');
      } catch {
        logError(cwd, `Stop failed to write session ${session_id}`);
        process.exit(0);
      }
    } finally {
      releaseLock(lockPath);
    }

    if (summary) process.stdout.write(summary + '\n');
    process.exit(0);
  } catch (err) {
    logError(process.cwd(), `Stop unexpected error: ${String(err).slice(0, 100)}`);
    process.exit(0);
  }
}

main();
