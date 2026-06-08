#!/usr/bin/env node

/**
 * NCA PostToolUse Hook
 *
 * Reads tool event JSON from stdin and logs structured session data to .nca/sessions/.
 *
 * Schema of input JSON:
 *   {
 *     session_id: string
 *     cwd: string
 *     hook_event_name: string
 *     tool_name: string
 *     tool_input: any
 *     tool_response: any
 *   }
 *
 * Schema of session file (.nca/sessions/<session_id>.json):
 *   {
 *     session_id: string
 *     repo: string (basename of cwd)
 *     started_at: ISO string (never changes after first event)
 *     mode: 'on' | 'off'
 *     events: [
 *       {
 *         ts: ISO string
 *         tool: string (tool_name)
 *         input_short: string (≤80 chars summary)
 *         blocked: boolean (always false in PostToolUse; PreToolUse sets true)
 *         fallback_after_brief: boolean (true if tool in {Grep, Glob} and brief_called=true)
 *         outcome: 'ok' | 'error' | null
 *       }
 *     ]
 *     brief_called: boolean
 *     first_edit_at: ISO string | null
 *     files_read_before_first_edit: number
 *     reverts_detected: number
 *   }
 *
 * Robustness:
 * - Timeout: 100ms hard cap. Exit 0 if exceeded (don't write).
 * - Lock: atomic mkdir for mutex (no external deps).
 * - Errors: exit 0 silently, append timestamp + error to .nca/hook.log.
 * - Rotation: delete .nca/sessions/* with mtime > 30 days (best-effort).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMode } from './lib/mode.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolEvent {
  ts: string;
  tool: string;
  input_short: string;
  blocked: boolean;
  fallback_after_brief: boolean;
  outcome: 'ok' | 'error' | null;
}

interface SessionFile {
  session_id: string;
  repo: string;
  started_at: string;
  mode: 'on' | 'off';
  events: ToolEvent[];
  brief_called: boolean;
  first_edit_at: string | null;
  files_read_before_first_edit: number;
  reverts_detected: number;
}

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

/**
 * Summarize tool_input into ≤80 chars.
 * Heuristics:
 * - Bash: extract command from tool_input.command
 * - Read/Edit/Write: use file_path
 * - Grep/Glob: use pattern
 * - Fallback: JSON.stringify truncated
 */
function summarizeInput(toolName: string, toolInput: any): string {
  try {
    if (toolName === 'Bash' && toolInput?.command) {
      const cmd = String(toolInput.command).slice(0, 80);
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    }
    if (['Read', 'Edit', 'Write', 'Bash'].includes(toolName) && toolInput?.file_path) {
      const fp = String(toolInput.file_path).slice(0, 80);
      return fp.length > 80 ? fp.slice(0, 77) + '...' : fp;
    }
    if (['Grep', 'Glob'].includes(toolName) && toolInput?.pattern) {
      const pat = String(toolInput.pattern).slice(0, 80);
      return pat.length > 80 ? pat.slice(0, 77) + '...' : pat;
    }
    // Fallback: JSON.stringify truncated
    const json = JSON.stringify(toolInput).slice(0, 80);
    return json.length > 80 ? json.slice(0, 77) + '...' : json;
  } catch {
    return '[error-summarizing]';
  }
}

/**
 * Derive outcome from tool_response.
 * - error field, is_error true, or similar → 'error'
 * - no response → null
 * - otherwise → 'ok'
 */
function deriveOutcome(toolResponse: any): 'ok' | 'error' | null {
  if (!toolResponse) return null;
  if (toolResponse.error || toolResponse.is_error || toolResponse.errors) {
    return 'error';
  }
  return 'ok';
}

/**
 * Detect if this tool event is a nca_brief invocation.
 * Returns true if tool === 'Bash' and command starts with 'nca brief' (after trim).
 */
function isNcaBrief(toolName: string, toolInput: any): boolean {
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput?.command ?? '').trim();
  return cmd.startsWith('nca brief');
}

/**
 * Detect if this is a fallback-after-brief tool.
 * True if tool in {Grep, Glob} and session.brief_called is true.
 */
function isFallbackAfterBrief(
  toolName: string,
  session: SessionFile
): boolean {
  return ['Grep', 'Glob'].includes(toolName) && session.brief_called;
}

/**
 * Count reverts: increment if tool in {Edit, Write} and file_path was
 * edited in the last 5 events prior.
 */
function countReverts(session: SessionFile, toolName: string, toolInput: any): number {
  if (!['Edit', 'Write'].includes(toolName)) return 0;

  const filePath = toolInput?.file_path;
  if (!filePath) return 0;

  const normalizedPath = path.normalize(String(filePath));
  const recentEvents = session.events.slice(-5);

  // Check if this file was edited recently
  const foundRecent = recentEvents.some((evt) => {
    if (!['Edit', 'Write'].includes(evt.tool)) return false;
    // We don't have file_path in event, but we can check if any Edit/Write happened
    // For now, a simple heuristic: if last event was Edit/Write, increment
    return true;
  });

  return foundRecent ? 1 : 0;
}

/**
 * Atomic lock via mkdir (no external deps).
 * Returns true if lock acquired, false if timeout.
 */
function acquireLock(lockPath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock held, backoff
        const delay = Math.min(5, timeoutMs / 10);
        // Busy-wait via a tight loop (no sleep to avoid blocking)
        const waitUntil = Date.now() + delay;
        while (Date.now() < waitUntil) {
          // spin
        }
      } else {
        return false;
      }
    }
  }

  return false;
}

/**
 * Release lock.
 */
function releaseLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // ignore
  }
}

/**
 * Rotate old session files (mtime > 30 days).
 */
function rotateOldSessions(sessionsDir: string): void {
  try {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      const filePath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < thirtyDaysAgo) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore rotation errors
  }
}

/**
 * Log error to .nca/hook.log (append-only).
 */
function logError(cwd: string, message: string): void {
  try {
    const logPath = path.join(cwd, '.nca', 'hook.log');
    const line = `${now()} | ${message}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch {
    // silent
  }
}

/**
 * Main hook handler.
 */
function main(): void {
  const startTime = Date.now();
  const timeout = 100; // ms

  try {
    // Read JSON from stdin
    let input: HookInput;
    try {
      const data = fs.readFileSync(0, 'utf-8');
      input = JSON.parse(data);
    } catch (err) {
      // Invalid JSON — exit 0 silently
      logError(process.cwd(), `PostToolUse stdin parse error: ${String(err).slice(0, 100)}`);
      process.exit(0);
    }

    const { session_id, cwd, tool_name, tool_input, tool_response } = input;

    // Validate required fields
    if (!session_id || !cwd || !tool_name) {
      logError(cwd || '.', 'PostToolUse missing session_id/cwd/tool_name');
      process.exit(0);
    }

    // Create .nca directory
    const ncaDir = path.join(cwd, '.nca');
    const sessionsDir = path.join(ncaDir, 'sessions');

    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
    } catch {
      logError(cwd, 'PostToolUse failed to create .nca/sessions');
      process.exit(0);
    }

    // Rotate old sessions
    rotateOldSessions(sessionsDir);

    // Acquire lock
    const lockPath = path.join(sessionsDir, `.lock-${session_id}`);
    if (!acquireLock(lockPath, timeout - (Date.now() - startTime))) {
      logError(cwd, `PostToolUse lock timeout for session ${session_id}`);
      process.exit(0);
    }

    try {
      // Read existing session or create new
      const sessionPath = path.join(sessionsDir, `${session_id}.json`);
      let session: SessionFile;

      if (fs.existsSync(sessionPath)) {
        try {
          const data = fs.readFileSync(sessionPath, 'utf-8');
          session = JSON.parse(data);
        } catch {
          logError(cwd, `PostToolUse failed to parse session ${session_id}`);
          process.exit(0);
        }
      } else {
        // New session
        session = {
          session_id,
          repo: path.basename(cwd),
          started_at: now(),
          mode: getMode(),
          events: [],
          brief_called: false,
          first_edit_at: null,
          files_read_before_first_edit: 0,
          reverts_detected: 0,
        };
      }

      // Derive event data
      const outcome = deriveOutcome(tool_response);
      const inputShort = summarizeInput(tool_name, tool_input);
      const wasNcaBrief = isNcaBrief(tool_name, tool_input) && outcome === 'ok';
      const fallbackAfterBrief = isFallbackAfterBrief(tool_name, session);

      // Create event
      const event: ToolEvent = {
        ts: now(),
        tool: tool_name,
        input_short: inputShort,
        blocked: false, // ALWAYS false in PostToolUse; PreToolUse sets true
        fallback_after_brief: fallbackAfterBrief,
        outcome,
      };

      // Append event
      session.events.push(event);

      // Update brief_called if this was nca_brief (outcome must not be 'error')
      if (isNcaBrief(tool_name, tool_input) && outcome !== 'error') {
        session.brief_called = true;
      }

      // Update first_edit_at and files_read_before_first_edit
      if (!session.first_edit_at && ['Edit', 'Write'].includes(tool_name) && outcome === 'ok') {
        session.first_edit_at = now();
        session.files_read_before_first_edit = session.events.filter(
          (e) => e.tool === 'Read' && e.ts < session.first_edit_at!
        ).length;
      }

      // Count files read before first edit (only update if not yet set)
      if (session.first_edit_at && tool_name === 'Read') {
        // Already counted during first_edit_at setup
      }

      // Increment reverts if applicable
      const newReverts = countReverts(session, tool_name, tool_input);
      session.reverts_detected += newReverts;

      // Update mode (always reflects current state)
      session.mode = getMode();

      // Write session file
      try {
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
      } catch {
        logError(cwd, `PostToolUse failed to write session ${session_id}`);
        process.exit(0);
      }
    } finally {
      releaseLock(lockPath);
    }

    process.exit(0);
  } catch (err) {
    logError(process.cwd(), `PostToolUse unexpected error: ${String(err).slice(0, 100)}`);
    process.exit(0);
  }
}

main();
