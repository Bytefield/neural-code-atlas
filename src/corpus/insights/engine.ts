import { OrientationEvent } from '../types.js';
import { Recommendation, VOCABULARY_VERSION, METHODOLOGY_VERSION, evidenceLevelForSampleSize } from './types.js';
import { RuleDefinition, REREAD_MEMORY_V1, SEARCH_FIRST_ACTION_V1, NCA_ASK_NOISY_FALLBACK_V1 } from './methodology.js';
import { computeRereadRate, RereadOptions } from './reread.js';
import { computeSearchFirstActionRate } from './search-first-action.js';
import { computeNcaAskNoisyFallbackRate } from './nca-ask-reliability.js';

export interface InsightsOptions {
  projectId: string;
  cwdFilterMode?: string; // e.g. 'main-only' — folded into `scope` when present
  reread?: RereadOptions;
}

function scopeFor(opts: InsightsOptions): string {
  return opts.cwdFilterMode ? `${opts.projectId}/${opts.cwdFilterMode}` : opts.projectId;
}

function buildRecommendation(
  id: string,
  def: RuleDefinition,
  computed: { value: number | null; denominator: number; sampleEvidence: string[] },
  opts: InsightsOptions,
): Recommendation {
  const insufficientEvidence = computed.denominator === 0 || computed.value === null;
  return {
    vocabulary_version: VOCABULARY_VERSION,
    project_id: opts.projectId,
    id,
    type: insufficientEvidence
      ? 'insufficient_evidence'
      : computed.value! >= def.threshold
        ? def.typeAboveThreshold
        : def.typeBelowThreshold,
    target: def.target,
    finding: def.finding,
    task_class: null,
    value: computed.value,
    threshold: def.threshold,
    rule: def.rule,
    evidence: computed.sampleEvidence,
    evidence_level: evidenceLevelForSampleSize(computed.denominator),
    scope: scopeFor(opts),
    expected_effect: def.expected_effect,
    metric_to_remeasure: def.metric_to_remeasure,
    expires_when: def.expires_when,
    methodology_version: METHODOLOGY_VERSION,
  };
}

/**
 * Computes all v1 insights recommendations from a project's orientation events.
 * Pure function — no I/O. Tolerant of v2 events (missing result_class): the
 * nca_ask fixture degrades to insufficient_evidence rather than inferring or
 * falling back to a hardcoded historical value (condition 5).
 *
 * Every rule here derives `value` from the input `events` — none may return a
 * fixed constant regardless of input (see insights-regression.test.js's
 * ANTI-HARDCODING guard: on zero events, every rule must report value=null). The
 * nca_ask recall gap (a real, documented finding — 26 source-text-present-
 * but-not-retrieved queries, roadmap-frozen 2026-09-14) is NOT a rule here for
 * exactly this reason: v1 cannot derive it from orientation_event data (recall
 * is a replay-fixture concern, not something this schema captures), so
 * representing it as an engine "rule" would mean either faking a derivation or
 * hardcoding its value — both wrong. It belongs in the vault ledger as a
 * recorded finding, not in this engine as a fabricated computation.
 */
export function computeInsights(events: OrientationEvent[], opts: InsightsOptions): Recommendation[] {
  const reread = computeRereadRate(events, opts.reread);
  const searchFirst = computeSearchFirstActionRate(events);
  const ncaAsk = computeNcaAskNoisyFallbackRate(events);

  return [
    buildRecommendation('INSIGHT-P4A-REREAD-V1', REREAD_MEMORY_V1, reread, opts),
    buildRecommendation('INSIGHT-BRIEF-SEARCH-FIRST-V1', SEARCH_FIRST_ACTION_V1, searchFirst, opts),
    buildRecommendation('INSIGHT-NCA-ASK-RELIABILITY-V1', NCA_ASK_NOISY_FALLBACK_V1, ncaAsk, opts),
  ];
}
