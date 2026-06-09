#!/usr/bin/env node

/**
 * NCA UserPromptSubmit hook — orientation telemetry.
 *
 * Records only a truncated hash and the length of each submitted prompt — never
 * the raw text. prompt_hash correlates events within a session without storing
 * content (see the prompt_hash note in docs/schema/orientation-events.md: this
 * is correlation, not cryptographic anonymization).
 *
 * Fail-open: exit 0 on any error; never block the session.
 *
 * Input JSON (stdin): { session_id, cwd, prompt?, hook_event_name? }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { now, logError } from './lib/io.js';
import { gitBranch } from './lib/git.js';
import { appendEvent } from './lib/events-store.js';
import { ORIENTATION_SCHEMA_VERSION, UserPromptSubmitEvent } from './lib/events.js';

interface HookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  hook_event_name?: string;
}

export function hashPrompt(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function main(): void {
  const TIMEOUT = 100; // ms
  const start = Date.now();

  try {
    let input: HookInput;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf-8'));
    } catch {
      // Static message: the error string could echo a fragment of the malformed
      // payload (which contains the prompt). Never include it.
      logError(process.cwd(), 'UserPromptSubmit stdin parse error');
      process.exit(0);
    }

    const { session_id, cwd, prompt } = input;
    if (!session_id || !cwd) {
      logError(cwd || '.', 'UserPromptSubmit missing session_id/cwd');
      process.exit(0);
    }

    const text = typeof prompt === 'string' ? prompt : '';
    const event: UserPromptSubmitEvent = {
      event_type: 'user_prompt_submit',
      session_id,
      timestamp: now(),
      repo_id: path.basename(cwd),
      cwd,
      git_branch: gitBranch(cwd),
      schema_version: ORIENTATION_SCHEMA_VERSION,
      payload: {
        prompt_hash: hashPrompt(text),
        prompt_length: text.length,
      },
    };

    appendEvent(cwd, event, { timeoutMs: Math.max(1, TIMEOUT - (Date.now() - start)) });
    process.exit(0);
  } catch (err) {
    logError(process.cwd(), `UserPromptSubmit unexpected error: ${String(err).slice(0, 100)}`);
    process.exit(0);
  }
}

main();
