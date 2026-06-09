/**
 * Orientation telemetry — event schema (schema_version 1).
 *
 * Single source of truth for the events written, one-per-line, to
 * `.nca/metrics/orientation-events.jsonl` (append-only). Consumed by the three
 * capture hooks (SessionStart, UserPromptSubmit, PostToolUse) on the write path
 * and by `nca metrics orientation` (--summary / --purge) on the read path.
 *
 * This PR defines EXACTLY THREE event types: `session_start`,
 * `user_prompt_submit`, `post_tool_use`. `session_end` is deliberately out of
 * scope — a robust end-of-session aggregate depends on the full capture chain
 * (PreCompact + PostCompact + SessionEnd best-effort) described in the vault
 * integration spec; capturing it half-way here would only yield an incomplete
 * baseline. Do not add a fourth event_type in this PR — stop and ask first.
 *
 * Discrimination contract: `event_type` is the discriminant. The union below is
 * exhaustive and unambiguous — narrowing on `event_type` narrows `payload` to
 * exactly one shape, with no overlap between members.
 *
 * Privacy contract: no raw prompt text and no raw tool input is ever stored.
 * `user_prompt_submit` keeps only a truncated hash + length (see prompt_hash
 * note in docs/schema/orientation-events.md). All string fields pass through
 * `redact()` before serialization.
 */

/** Bump only on a breaking change to the on-disk event shape. */
export const ORIENTATION_SCHEMA_VERSION = 1;

/** The three — and only three — event types this schema version defines. */
export const ORIENTATION_EVENT_TYPES = [
  'session_start',
  'user_prompt_submit',
  'post_tool_use',
] as const;

export type OrientationEventType = (typeof ORIENTATION_EVENT_TYPES)[number];

// ─── Per-event payloads ───────────────────────────────────────────────────────

/** SessionStart hook matcher that triggered the event. */
export type SessionStartMatcher = 'startup' | 'resume' | 'clear' | 'compact';

export interface SessionStartPayload {
  matcher: SessionStartMatcher;
}

export interface UserPromptSubmitPayload {
  /** sha256 of the original prompt, first 16 hex chars. Correlation only — NOT anonymization. */
  prompt_hash: string;
  /** Character length of the original prompt. */
  prompt_length: number;
}

export interface PostToolUsePayload {
  tool_name: string;
  /** Normalized absolute/relative file path when the tool acts on a file, else null. */
  file_path: string | null;
  /** Tool execution duration in ms when the host provides it, else null. */
  duration_ms: number | null;
  outcome: 'ok' | 'error' | null;
}

// ─── Common envelope ──────────────────────────────────────────────────────────

interface OrientationEventBase {
  session_id: string;
  /** ISO 8601, UTC. */
  timestamp: string;
  /** Stable id for the repo — basename(cwd). */
  repo_id: string;
  /** Absolute working directory. */
  cwd: string;
  /** Current git branch, or null when cwd is not a git repo. */
  git_branch: string | null;
  /** Always ORIENTATION_SCHEMA_VERSION for events written by this code. */
  schema_version: number;
}

// ─── Discriminated union ────────────────────────────────────────────────────────

export interface SessionStartEvent extends OrientationEventBase {
  event_type: 'session_start';
  payload: SessionStartPayload;
}

export interface UserPromptSubmitEvent extends OrientationEventBase {
  event_type: 'user_prompt_submit';
  payload: UserPromptSubmitPayload;
}

export interface PostToolUseEvent extends OrientationEventBase {
  event_type: 'post_tool_use';
  payload: PostToolUsePayload;
}

export type OrientationEvent =
  | SessionStartEvent
  | UserPromptSubmitEvent
  | PostToolUseEvent;
