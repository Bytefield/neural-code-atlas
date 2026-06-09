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

/** A lock dir older than this is treated as orphaned (its holder died). */
const STALE_LOCK_MS = 5000;

/**
 * Atomic lock via mkdir. Returns true if acquired, false on timeout. Busy-waits
 * in short spins to stay within sub-second hook budgets.
 *
 * Stale-lock recovery: if the lock dir already exists but its mtime is older
 * than STALE_LOCK_MS, its holder is assumed dead (killed mid-write) and the
 * lock is stolen once (rmdir + retry). This prevents a single crashed hook from
 * silently blocking every future write.
 */
export function acquireLock(lockPath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  let stolen = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        if (!stolen) {
          try {
            const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
            if (ageMs > STALE_LOCK_MS) {
              fs.rmdirSync(lockPath);
              stolen = true;
              continue; // retry mkdir immediately
            }
          } catch {
            // stat/rmdir lost a race with another process — fall through to wait
          }
        }
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
