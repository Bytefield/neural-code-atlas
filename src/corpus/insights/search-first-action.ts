import { OrientationEvent } from '../types.js';

const DEQUEUE_THRESHOLD_MS = 10_000;

const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'mcp__nca__nca_ask', 'mcp__nca__nca_flow']);
const EXEC_TOOLS = new Set(['Bash']);
const DIRECT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

export type FirstActionBucket = 'SEARCH' | 'EXEC' | 'DIRECT' | 'OTHER' | 'NONE';

function classifyFirstTool(toolName: string | undefined): FirstActionBucket {
  if (!toolName) return 'NONE';
  if (SEARCH_TOOLS.has(toolName)) return 'SEARCH';
  if (EXEC_TOOLS.has(toolName)) return 'EXEC';
  if (DIRECT_TOOLS.has(toolName)) return 'DIRECT';
  return 'OTHER';
}

export interface SearchFirstActionResult {
  value: number | null; // SEARCH segments / total segments, or null if no segments
  numerator: number;
  denominator: number;
  buckets: Record<FirstActionBucket, number>;
  queuedPromptsMerged: number;
  sampleEvidence: string[]; // "session:<id>" pointers, a few sessions whose first segment was SEARCH
}

/**
 * SEARCH_FIRST_ACTION_V1 — reproduces the D2/Brief exploratory methodology's final
 * ("doubly corrected") figure: mcp__nca__nca_ask / mcp__nca__nca_flow reclassified
 * into SEARCH (they ARE orientation, just via NCA instead of Read/Grep), and
 * consecutive same-session prompts fired within 10s of each other treated as one
 * logical turn (a queued follow-up, not two independent turns whose first one
 * spuriously scores NONE) — see EXPLORATORY-ANALYSIS-P4A-BRIEF-INJECTION-2026-08-20,
 * PASADA 2 + verifications V1/V2.
 *
 * Population (denominator) is every surviving prompt segment, including NONE —
 * a segment with no tool calls before the next prompt is still a real turn.
 */
export function computeSearchFirstActionRate(events: OrientationEvent[]): SearchFirstActionResult {
  const bySession = new Map<string, OrientationEvent[]>();
  for (const ev of events) {
    const bucket = bySession.get(ev.source_session_id);
    if (bucket) bucket.push(ev);
    else bySession.set(ev.source_session_id, [ev]);
  }

  const buckets: Record<FirstActionBucket, number> = { SEARCH: 0, EXEC: 0, DIRECT: 0, OTHER: 0, NONE: 0 };
  let queuedPromptsMerged = 0;
  const searchSessionIds = new Set<string>();

  for (const [sessionId, sessionEvents] of bySession) {
    const sorted = [...sessionEvents].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
    const prompts = sorted.filter(e => e.event_type === 'user_prompt_submit');
    if (prompts.length === 0) continue;

    // A prompt starts a new segment unless it's within DEQUEUE_THRESHOLD_MS of the
    // immediately preceding prompt in the same session — that case is absorbed into
    // the segment already open (chains of rapid-fire prompts collapse to one).
    const segmentStarts: OrientationEvent[] = [];
    for (let i = 0; i < prompts.length; i++) {
      if (i === 0) {
        segmentStarts.push(prompts[i]);
        continue;
      }
      const gap = new Date(prompts[i].timestamp).getTime() - new Date(prompts[i - 1].timestamp).getTime();
      if (gap <= DEQUEUE_THRESHOLD_MS) {
        queuedPromptsMerged++;
      } else {
        segmentStarts.push(prompts[i]);
      }
    }

    const toolEvents = sorted.filter(e => e.event_type === 'post_tool_use');
    for (let i = 0; i < segmentStarts.length; i++) {
      const startTs = segmentStarts[i].timestamp;
      const endTs = i + 1 < segmentStarts.length ? segmentStarts[i + 1].timestamp : null;
      const firstTool = toolEvents.find(t =>
        t.timestamp >= startTs && (endTs === null || t.timestamp < endTs),
      );
      const bucket = classifyFirstTool(firstTool?.tool_name);
      buckets[bucket]++;
      if (bucket === 'SEARCH' && searchSessionIds.size < 5) searchSessionIds.add(sessionId);
    }
  }

  const denominator = buckets.SEARCH + buckets.EXEC + buckets.DIRECT + buckets.OTHER + buckets.NONE;
  return {
    value: denominator > 0 ? buckets.SEARCH / denominator : null,
    numerator: buckets.SEARCH,
    denominator,
    buckets,
    queuedPromptsMerged,
    sampleEvidence: [...searchSessionIds].map(id => `session:${id}`),
  };
}
