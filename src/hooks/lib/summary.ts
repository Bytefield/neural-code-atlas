/**
 * Read-side aggregation for orientation telemetry.
 *
 * Turns the raw event stream into per-session summaries. Everything here is
 * derived (not stored): orientation tool-calls are counted raw and unclassified
 * (no blast-radius classification), reads are listed with their paths, and the
 * first edit is a candidate only — "relevant" is not resolved against git.
 */

import { OrientationEvent } from './events.js';

/** Tools that count as orientation/search activity (raw, unclassified). */
export const ORIENTATION_TOOLS = new Set(['Glob', 'Grep', 'LS', 'Find', 'Read']);
/** Tools that count as an edit for the first-edit candidate. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export interface SessionSummary {
  session_id: string;
  repo_id: string;
  git_branch: string | null;
  started_at: string | null;
  prompts: number;
  tool_calls: number;
  orientation_tool_calls: number;
  reads: number;
  read_paths: string[];
  first_edit_at: string | null;
  /** User turns before (and including) the first edit candidate; null if no edit. */
  turns_to_first_edit: number | null;
  /** Reads before the first edit candidate; null if no edit. */
  reads_before_first_edit: number | null;
}

function emptySummary(id: string): SessionSummary {
  return {
    session_id: id,
    repo_id: '',
    git_branch: null,
    started_at: null,
    prompts: 0,
    tool_calls: 0,
    orientation_tool_calls: 0,
    reads: 0,
    read_paths: [],
    first_edit_at: null,
    turns_to_first_edit: null,
    reads_before_first_edit: null,
  };
}

/** Group events by session and derive a summary per session (chronological). */
export function summarize(events: OrientationEvent[]): SessionSummary[] {
  const bySession = new Map<string, OrientationEvent[]>();
  for (const e of events) {
    const arr = bySession.get(e.session_id) ?? [];
    arr.push(e);
    bySession.set(e.session_id, arr);
  }

  const summaries: SessionSummary[] = [];
  for (const [id, evts] of bySession) {
    const sorted = [...evts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const s = emptySummary(id);
    s.repo_id = sorted[0]?.repo_id ?? '';
    s.git_branch = sorted[0]?.git_branch ?? null;
    s.started_at = sorted[0]?.timestamp ?? null;

    // First edit candidate (earliest post_tool_use whose tool is an edit).
    const firstEdit = sorted.find(
      (e) => e.event_type === 'post_tool_use' && EDIT_TOOLS.has(e.payload.tool_name)
    );
    s.first_edit_at = firstEdit ? firstEdit.timestamp : null;

    for (const e of sorted) {
      if (e.event_type === 'user_prompt_submit') {
        s.prompts++;
      } else if (e.event_type === 'post_tool_use') {
        s.tool_calls++;
        const tool = e.payload.tool_name;
        if (ORIENTATION_TOOLS.has(tool)) s.orientation_tool_calls++;
        if (tool === 'Read') {
          s.reads++;
          if (e.payload.file_path) s.read_paths.push(e.payload.file_path);
        }
      }
    }

    if (s.first_edit_at) {
      const cutoff = s.first_edit_at;
      s.turns_to_first_edit = sorted.filter(
        (e) => e.event_type === 'user_prompt_submit' && e.timestamp <= cutoff
      ).length;
      s.reads_before_first_edit = sorted.filter(
        (e) =>
          e.event_type === 'post_tool_use' &&
          e.payload.tool_name === 'Read' &&
          e.timestamp < cutoff
      ).length;
    }

    summaries.push(s);
  }

  // Most recent session first.
  return summaries.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
}

export interface Stats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

/** Population mean/stddev/min/max. Zeroed for an empty input. */
export function stats(nums: number[]): Stats {
  if (nums.length === 0) return { mean: 0, stddev: 0, min: 0, max: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return { mean, stddev: Math.sqrt(variance), min: Math.min(...nums), max: Math.max(...nums) };
}

export interface OrientationAggregate {
  session_count: number;
  /** Cross-session distribution of raw orientation tool-calls (the headline variance). */
  orientation_tool_calls: Stats;
  reads: Stats;
  /** turns-to-first-edit over the sessions that reached an edit. */
  turns_to_first_edit: Stats;
  sessions_with_edit: number;
}

/** Cross-session aggregate, including the variance (stddev) of orientation tool-calls. */
export function aggregate(summaries: SessionSummary[]): OrientationAggregate {
  const ttfe = summaries
    .filter((s) => s.turns_to_first_edit != null)
    .map((s) => s.turns_to_first_edit as number);
  return {
    session_count: summaries.length,
    orientation_tool_calls: stats(summaries.map((s) => s.orientation_tool_calls)),
    reads: stats(summaries.map((s) => s.reads)),
    turns_to_first_edit: stats(ttfe),
    sessions_with_edit: ttfe.length,
  };
}
