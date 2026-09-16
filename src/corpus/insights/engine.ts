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

// Case 4 (non-gating): the 26-query nca_ask recall gap, root-caused across several
// prior tasks (PR #58-#60) and named in the frozen roadmap itself ("Known capability
// gap, recorded, not acted on... not a B blocker; the noisy fallback was hiding
// it. Do not touch nca_ask matching before Phase B says whether recall deserves
// investment"). This is NOT computed from corpus events — recall is a replay-fixture
// concern (frozen indices, test/replay/), not something `orientation_event` schema
// captures. It is surfaced here as a static, explicitly-labeled finding so the
// engine's output is a complete picture of the known nca_ask evidence, not because
// this engine measured it. The .tsx grammar fix (PR #62, after the roadmap freeze)
// likely reduced this count; re-measuring it is Replay A/B's job, not this one's —
// left undone here rather than guessed at.
function buildRecallGapFinding(opts: InsightsOptions): Recommendation {
  return {
    vocabulary_version: VOCABULARY_VERSION,
    project_id: opts.projectId,
    id: 'INSIGHT-NCA-ASK-RECALL-V1',
    type: 'no_intervention',
    target: 'nca_ask_matcher',
    finding: 'source_text_present_but_not_retrieved',
    task_class: null,
    value: 26,
    threshold: null,
    rule: 'NCA_ASK_RECALL_GAP_V1',
    evidence: ['file:test/replay/recall-subclassification.md', 'file:test/replay/rootcause-2gaps.md'],
    evidence_level: 'EVIDENCE_MODERATE',
    scope: scopeFor(opts),
    expected_effect: 'not evaluated — recorded pending a decision on whether recall deserves investment',
    metric_to_remeasure: 'replay_recall_gap_count',
    expires_when: 'a Replay A/B re-run after a matcher/indexer change, or Phase B explicitly decides on recall',
    methodology_version: METHODOLOGY_VERSION,
  };
}

/**
 * Computes all v1 insights recommendations from a project's orientation events.
 * Pure function — no I/O. Tolerant of v2 events (missing result_class): the
 * nca_ask fixture degrades to insufficient_evidence rather than inferring or
 * falling back to a hardcoded historical value (condition 5).
 */
export function computeInsights(events: OrientationEvent[], opts: InsightsOptions): Recommendation[] {
  const reread = computeRereadRate(events, opts.reread);
  const searchFirst = computeSearchFirstActionRate(events);
  const ncaAsk = computeNcaAskNoisyFallbackRate(events);

  return [
    buildRecommendation('INSIGHT-P4A-REREAD-V1', REREAD_MEMORY_V1, reread, opts),
    buildRecommendation('INSIGHT-BRIEF-SEARCH-FIRST-V1', SEARCH_FIRST_ACTION_V1, searchFirst, opts),
    buildRecommendation('INSIGHT-NCA-ASK-RELIABILITY-V1', NCA_ASK_NOISY_FALLBACK_V1, ncaAsk, opts),
    buildRecallGapFinding(opts),
  ];
}
