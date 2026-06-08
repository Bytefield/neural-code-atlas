/**
 * Shared session-log types and helpers.
 *
 * Consumed by the PostToolUse hook (write path), the Stop hook (read + update
 * last_stop_at), and the `nca session report` / `nca compare` CLI commands
 * (read-only). Keeping the SessionFile contract and the file-system access in
 * one module avoids type drift across those four consumers.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolEvent {
  ts: string;
  tool: string;
  input_short: string;
  blocked: boolean;
  fallback_after_brief: boolean;
  outcome: 'ok' | 'error' | null;
  // Normalized file_path, only set for Edit/Write. Used by revert detection
  // to compare against prior events touching the same file.
  file_path?: string;
}

export interface SessionFile {
  session_id: string;
  repo: string;
  started_at: string;
  mode: 'on' | 'off';
  events: ToolEvent[];
  brief_called: boolean;
  first_edit_at: string | null;
  files_read_before_first_edit: number;
  reverts_detected: number;
  // Maintained by the Stop hook: ISO of the last turn boundary it processed.
  last_stop_at?: string;
}

// ─── Time ───────────────────────────────────────────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function sessionsDir(cwd: string): string {
  return path.join(cwd, '.nca', 'sessions');
}

export function sessionPath(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Read and parse a session file. Returns null if it does not exist or cannot
 * be parsed — callers decide how to surface "not found".
 */
export function readSession(cwd: string, sessionId: string): SessionFile | null {
  try {
    const p = sessionPath(cwd, sessionId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SessionFile;
  } catch {
    return null;
  }
}

/**
 * List session ids in a repo, most recently modified first. Ignores lock dirs
 * and any non-.json entries.
 */
export function listSessions(cwd: string): Array<{ id: string; mtimeMs: number }> {
  const dir = sessionsDir(cwd);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const id = f.slice(0, -'.json'.length);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs;
        } catch {
          // ignore stat errors; treat as oldest
        }
        return { id, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/**
 * A logged event is an `nca brief` invocation if it ran as a Bash command whose
 * (already-summarized) input starts with `nca brief`. The PostToolUse hook does
 * not rename the tool, so brief detection is uniform on the read side.
 */
export function isBriefEvent(event: ToolEvent): boolean {
  return event.tool === 'Bash' && event.input_short.trim().startsWith('nca brief');
}

// ─── Lock + logging (hook write paths only) ──────────────────────────────────

/**
 * Atomic lock via mkdir (no external deps). Returns true if acquired, false on
 * timeout. Busy-waits in short spins to stay within sub-second hook budgets.
 */
export function acquireLock(lockPath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        const delay = Math.min(5, timeoutMs / 10);
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

export function releaseLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // ignore
  }
}

/**
 * Append a timestamped line to <cwd>/.nca/hook.log. Never throws.
 */
export function logError(cwd: string, message: string): void {
  try {
    const logPath = path.join(cwd, '.nca', 'hook.log');
    fs.appendFileSync(logPath, `${now()} | ${message}\n`, 'utf-8');
  } catch {
    // silent
  }
}
