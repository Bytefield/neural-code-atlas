import { OrientationEvent } from '../types.js';
import { NcaAskResultClass } from '../nca-ask-result-class.js';

const NCA_ASK_TOOL_NAME = 'mcp__nca__nca_ask';

export interface NcaAskReliabilityResult {
  value: number | null;       // noisy_fallback count / classifiable count, or null if 0 classifiable
  numerator: number;
  denominator: number;        // classifiable = events with a result_class
  totalCallsSeen: number;     // all mcp__nca__nca_ask post_tool_use events, classifiable or not
  unclassifiableCalls: number; // totalCallsSeen - denominator (no paired tool_result found, or pre-v3 data)
  classCounts: Record<NcaAskResultClass, number>;
  sampleEvidence: string[];   // "session:<id>" pointers, a few sessions with a noisy_fallback call
}

/**
 * NCA_ASK_NOISY_FALLBACK_V1 — fraction of mcp__nca__nca_ask calls whose result_class
 * is noisy_fallback (a real query that returned a flow-content dump instead of a
 * clean no-match), the defect fixed by REC-0001.
 *
 * population_scope = historical_all_nca_ask_calls (condition 6): this counts every
 * classifiable nca_ask call the input events contain, scoped only by whatever
 * project/window the caller already selected events for. It does NOT reconstruct
 * REC-0001's in-scope/out-of-scope split (schema v3 carries no field for that) — a
 * documented limitation, not silently resolved here.
 *
 * Only events with a result_class are classifiable: events from schema v2 (predates
 * this field), or a v3 nca_ask call whose tool_result never got paired, count toward
 * totalCallsSeen but not the denominator — they are not asserted to be any class.
 */
export function computeNcaAskNoisyFallbackRate(events: OrientationEvent[]): NcaAskReliabilityResult {
  const calls = events.filter(e => e.event_type === 'post_tool_use' && e.tool_name === NCA_ASK_TOOL_NAME);
  const classifiable = calls.filter(e => e.result_class !== undefined);

  const classCounts: Record<NcaAskResultClass, number> = {
    direct_hit: 0,
    clean_no_match: 0,
    noisy_fallback: 0,
    known_env_error: 0,
    product_error: 0,
  };
  // Set, not array: a session with multiple noisy_fallback calls must not crowd
  // out the 5-item sample with duplicates of itself (see search-first-action.ts's
  // identical fix, commit eaf7c6a).
  const noisySessionIds = new Set<string>();
  for (const e of classifiable) {
    const cls = e.result_class as NcaAskResultClass;
    classCounts[cls]++;
    if (cls === 'noisy_fallback' && noisySessionIds.size < 5) noisySessionIds.add(e.source_session_id);
  }

  const denominator = classifiable.length;
  return {
    value: denominator > 0 ? classCounts.noisy_fallback / denominator : null,
    numerator: classCounts.noisy_fallback,
    denominator,
    totalCallsSeen: calls.length,
    unclassifiableCalls: calls.length - denominator,
    classCounts,
    sampleEvidence: [...noisySessionIds].map(id => `session:${id}`),
  };
}
