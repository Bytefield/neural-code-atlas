/**
 * Append-only store for orientation telemetry events.
 *
 * Events are written one-per-line to .nca/metrics/orientation-events.jsonl.
 * Every event is redacted before serialization and the serialized line is
 * scrubbed a second time (defense in depth) before it touches disk. Writes take
 * an mkdir mutex so concurrent hooks never interleave a partial line.
 *
 * No derived metrics are stored — first-edit, reads-before-edit, reverts and
 * cross-session variance are all computed on the read side from the raw stream.
 */

import * as fs from 'fs';
import * as path from 'path';
import { acquireLock, releaseLock, logError } from './io.js';
import { redact, redactLine } from './redact.js';
import { OrientationEvent } from './events.js';

export function metricsDir(cwd: string): string {
  return path.join(cwd, '.nca', 'metrics');
}

export function eventsPath(cwd: string): string {
  return path.join(metricsDir(cwd), 'orientation-events.jsonl');
}

/**
 * Append one event as a redacted JSONL line. Best-effort and never throws —
 * returns true if written, false otherwise. `timeoutMs` bounds the lock wait so
 * a contended write still respects the caller's hook budget.
 */
export function appendEvent(
  cwd: string,
  event: OrientationEvent,
  opts: { timeoutMs?: number } = {}
): boolean {
  const timeoutMs = opts.timeoutMs ?? 100;
  const start = Date.now();
  try {
    const dir = metricsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });

    const lockPath = path.join(dir, '.lock');
    if (!acquireLock(lockPath, Math.max(1, timeoutMs - (Date.now() - start)))) {
      logError(cwd, 'orientation appendEvent lock timeout');
      return false;
    }
    try {
      const line = redactLine(JSON.stringify(redact(event)));
      fs.appendFileSync(eventsPath(cwd), line + '\n', 'utf-8');
      return true;
    } finally {
      releaseLock(lockPath);
    }
  } catch (err) {
    logError(cwd, `orientation appendEvent failed: ${String(err).slice(0, 100)}`);
    return false;
  }
}

/** Read and parse every event. Skips blank and malformed lines. Never throws. */
export function readEvents(cwd: string): OrientationEvent[] {
  try {
    const p = eventsPath(cwd);
    if (!fs.existsSync(p)) return [];
    const out: OrientationEvent[] = [];
    for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as OrientationEvent);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Drop events older than `olderThanDays`, rewriting the file atomically
 * (tmp + rename) under the write lock. Returns how many events were removed.
 * Best-effort; never throws.
 */
export function pruneEvents(cwd: string, olderThanDays: number): number {
  const p = eventsPath(cwd);
  try {
    if (!fs.existsSync(p)) return 0;
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const lockPath = path.join(metricsDir(cwd), '.lock');
    if (!acquireLock(lockPath, 1000)) {
      logError(cwd, 'orientation pruneEvents lock timeout');
      return 0;
    }
    try {
      const kept: string[] = [];
      let removed = 0;
      for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let ts = NaN;
        try {
          ts = Date.parse((JSON.parse(line) as OrientationEvent).timestamp);
        } catch {
          ts = NaN;
        }
        // Keep events that are recent OR whose timestamp is unparseable (never
        // silently discard data we cannot date).
        if (!isNaN(ts) && ts < cutoff) {
          removed++;
          continue;
        }
        kept.push(line);
      }
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf-8');
      fs.renameSync(tmp, p);
      return removed;
    } finally {
      releaseLock(lockPath);
    }
  } catch (err) {
    logError(cwd, `orientation pruneEvents failed: ${String(err).slice(0, 100)}`);
    return 0;
  }
}
