#!/usr/bin/env node

/**
 * NCA PostToolUse hook — orientation telemetry.
 *
 * Reads the tool event JSON from stdin and appends one redacted `post_tool_use`
 * event to .nca/metrics/orientation-events.jsonl. This hook records raw events
 * only — every derived orientation metric (reads-before-first-edit, first-edit
 * candidate, reverts, cross-session variance) is computed later on the read side
 * by `nca metrics orientation --summary`.
 *
 * Privacy: the raw tool input/command is never stored — only tool_name,
 * file_path, duration_ms and outcome. The event is redacted before write.
 *
 * Robustness (fail-open):
 * - 100ms hard budget passed to the store's lock wait.
 * - Any error → exit 0 silently (+ a line in .nca/hook.log). A logging failure
 *   must never block or break the Claude Code session.
 *
 * Input JSON (stdin):
 *   { session_id, cwd, hook_event_name?, tool_name, tool_input?, tool_response? }
 */

import * as fs from 'fs';
import * as path from 'path';
import { now, logError } from './lib/io.js';
import { gitBranch } from './lib/git.js';
import { appendEvent } from './lib/events-store.js';
import { ORIENTATION_SCHEMA_VERSION, PostToolUseEvent } from './lib/events.js';

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input?: any;
  tool_response?: any;
}

function deriveOutcome(toolResponse: any): 'ok' | 'error' | null {
  if (!toolResponse) return null;
  if (toolResponse.error || toolResponse.is_error || toolResponse.errors) return 'error';
  return 'ok';
}

function deriveFilePath(toolInput: any): string | null {
  const fp = toolInput?.file_path;
  return typeof fp === 'string' && fp.length > 0 ? path.normalize(fp) : null;
}

function deriveDurationMs(toolResponse: any): number | null {
  const d = toolResponse?.duration_ms ?? toolResponse?.durationMs;
  return typeof d === 'number' && isFinite(d) ? d : null;
}

function main(): void {
  const TIMEOUT = 100; // ms
  const start = Date.now();

  try {
    let input: HookInput;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf-8'));
    } catch (err) {
      logError(process.cwd(), `PostToolUse stdin parse error: ${String(err).slice(0, 100)}`);
      process.exit(0);
    }

    const { session_id, cwd, tool_name, tool_input, tool_response } = input;
    if (!session_id || !cwd || !tool_name) {
      logError(cwd || '.', 'PostToolUse missing session_id/cwd/tool_name');
      process.exit(0);
    }

    const event: PostToolUseEvent = {
      event_type: 'post_tool_use',
      session_id,
      timestamp: now(),
      repo_id: path.basename(cwd),
      cwd,
      git_branch: gitBranch(cwd),
      schema_version: ORIENTATION_SCHEMA_VERSION,
      payload: {
        tool_name,
        file_path: deriveFilePath(tool_input),
        duration_ms: deriveDurationMs(tool_response),
        outcome: deriveOutcome(tool_response),
      },
    };

    appendEvent(cwd, event, { timeoutMs: Math.max(1, TIMEOUT - (Date.now() - start)) });
    process.exit(0);
  } catch (err) {
    logError(process.cwd(), `PostToolUse unexpected error: ${String(err).slice(0, 100)}`);
    process.exit(0);
  }
}

main();
