/**
 * Shared filesystem helpers for the orientation telemetry hooks and store:
 * timestamping, an mkdir-based mutex (no external deps), and a never-throwing
 * error log. Kept in one module so every write path shares one contract.
 */

import * as fs from 'fs';
import * as path from 'path';

export function now(): string {
  return new Date().toISOString();
}

/**
 * Atomic lock via mkdir. Returns true if acquired, false on timeout. Busy-waits
 * in short spins to stay within sub-second hook budgets.
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

/** Append a timestamped line to <cwd>/.nca/hook.log. Never throws. */
export function logError(cwd: string, message: string): void {
  try {
    const logPath = path.join(cwd, '.nca', 'hook.log');
    fs.appendFileSync(logPath, `${now()} | ${message}\n`, 'utf-8');
  } catch {
    // silent
  }
}
