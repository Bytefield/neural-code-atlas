// Methodology v1 — frozen thresholds and rule metadata for `nca corpus insights`.
//
// Rule names are proposed here (condition 7 of the Phase 2 task order): none of
// REREAD_MEMORY_V1, SEARCH_FIRST_ACTION_V1 or NCA_ASK_NOISY_FALLBACK_V1 existed
// as a named rule in the vault ledger before this file — only the underlying
// numbers (P4a/Brief exploratory doc, REC-0001) did. The thresholds themselves are
// NOT proposed: they come from DECISION-INSIGHTS-OVER-INJECTION-2026-08-20's guard
// ("reabrir si >40% reread evitable o >30% SEARCH-primero con tramos largos") and
// from REC-0001's own framing of the nca_ask noisy-fallback baseline.
//
// P4a's historical secondary 0.2 threshold ("baja prioridad" line) is explicitly
// NOT part of REREAD_MEMORY_V1 — condition 7 keeps it as an exploratory-only
// observation. It is recorded here as a comment, not a field, so nothing in the
// engine can accidentally gate on it.

export const METHODOLOGY_VERSION = '1';

export interface RuleDefinition {
  rule: string;
  target: string;
  finding: string;
  threshold: number;
  // type when value >= threshold, and when value < threshold — polarity differs
  // per rule (REREAD/SEARCH_FIRST ask "is there enough opportunity to build",
  // NCA_ASK_NOISY_FALLBACK asks "is there a problem severe enough to fix").
  typeAboveThreshold: 'do' | 'fix';
  typeBelowThreshold: 'dont_build' | 'no_intervention';
  expected_effect: string;
  metric_to_remeasure: string;
  expires_when: string;
}

export const REREAD_MEMORY_V1: RuleDefinition = {
  rule: 'REREAD_MEMORY_V1',
  target: 'session_memory',
  finding: 'avoidable_reread',
  // DECISION-INSIGHTS-OVER-INJECTION-2026-08-20 guard: reopen only above 40%.
  // Historical 0.2 ("baja prioridad") line is exploratory-only, not encoded here.
  threshold: 0.4,
  typeAboveThreshold: 'do',
  typeBelowThreshold: 'dont_build',
  expected_effect: 'reduce redundant cross-session Read calls on the same file',
  metric_to_remeasure: 'median_pre_edit_read_tools',
  expires_when: 'next full corpus re-extraction for this project, or methodology_version bumps',
};

export const SEARCH_FIRST_ACTION_V1: RuleDefinition = {
  rule: 'SEARCH_FIRST_ACTION_V1',
  target: 'brief_injection',
  finding: 'search_first_action_rate',
  // Same guard doc: reopen only above 30% SEARCH-first with long stretches.
  threshold: 0.3,
  typeAboveThreshold: 'do',
  typeBelowThreshold: 'dont_build',
  expected_effect: 'reduce orientation reads by pre-injecting relevant context at prompt time',
  metric_to_remeasure: 'search_first_action_rate',
  expires_when: 'next full corpus re-extraction for this project, or methodology_version bumps',
};

export const NCA_ASK_NOISY_FALLBACK_V1: RuleDefinition = {
  rule: 'NCA_ASK_NOISY_FALLBACK_V1',
  target: 'nca_ask_matcher',
  finding: 'noisy_fallback_dominant',
  // REC-0001's own framing of the pre-fix baseline (48/64, later corrected to
  // 47/64 alongside the (no results) legacy-format fix, PR #58).
  threshold: 0.4,
  typeAboveThreshold: 'fix',
  typeBelowThreshold: 'no_intervention',
  expected_effect: 'reduce noisy_fallback share of nca_ask responses',
  metric_to_remeasure: 'nca_ask_noisy_fallback_rate',
  expires_when: 'classifier version bumps, or methodology_version bumps',
};
