#!/usr/bin/env node

/**
 * NCA SessionStart hook — orientation telemetry.
 *
 * Records one session_start event with the matcher that triggered it
 * (startup | resume | clear | compact). The matcher comes from the host's
 * `source` field; anything missing/unknown defaults to "startup".
 *
 * Fail-open: exit 0 on any error; never block the session.
 *
 * Input JSON (stdin): { session_id, cwd, source?, hook_event_name? }
 */

import * as fs from 'fs';
import * as path from 'path';
import { now, logError } from './lib/io.js';
import { gitBranch } from './lib/git.js';
import { appendEvent } from './lib/events-store.js';
import {
  ORIENTATION_SCHEMA_VERSION,
  SessionStartEvent,
  SessionStartMatcher,
} from './lib/events.js';

interface HookInput {
  session_id: string;
  cwd: string;
  source?: string;
  matcher?: string;
  hook_event_name?: string;
}

const VALID_MATCHERS: SessionStartMatcher[] = ['startup', 'resume', 'clear', 'compact'];

function normalizeMatcher(value: unknown): SessionStartMatcher {
  return typeof value === 'string' && (VALID_MATCHERS as string[]).includes(value)
    ? (value as SessionStartMatcher)
    : 'startup';
}

function main(): void {
  const TIMEOUT = 100; // ms
  const start = Date.now();

  try {
    let input: HookInput;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf-8'));
    } catch (err) {
      logError(process.cwd(), `SessionStart stdin parse error: ${String(err).slice(0, 100)}`);
      process.exit(0);
    }

    const { session_id, cwd } = input;
    if (!session_id || !cwd) {
      logError(cwd || '.', 'SessionStart missing session_id/cwd');
      process.exit(0);
    }

    const event: SessionStartEvent = {
      event_type: 'session_start',
      session_id,
      timestamp: now(),
      repo_id: path.basename(cwd),
      cwd,
      git_branch: gitBranch(cwd),
      schema_version: ORIENTATION_SCHEMA_VERSION,
      payload: {
        matcher: normalizeMatcher(input.source ?? input.matcher),
      },
    };

    appendEvent(cwd, event, { timeoutMs: Math.max(1, TIMEOUT - (Date.now() - start)) });
    process.exit(0);
  } catch (err) {
    logError(process.cwd(), `SessionStart unexpected error: ${String(err).slice(0, 100)}`);
    process.exit(0);
  }
}

main();
