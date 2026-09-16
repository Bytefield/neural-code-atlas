import { NcaAskResultClass, NCA_ASK_RESULT_CLASSIFIER_VERSION } from './nca-ask-result-class.js';

export const SCHEMA_VERSION = 'orientation_event_v3' as const;
export const EXTRACTOR_VERSION = '0.1.0' as const;

export type ExperimentPhase = 'baseline' | 'treatment';
export type EventType = 'session_start' | 'user_prompt_submit' | 'post_tool_use';
export type CwdFilterMode = 'main-only' | 'include-worktrees';

export interface OrientationEvent {
  event_id: string;
  schema_version: typeof SCHEMA_VERSION;
  extractor_version: typeof EXTRACTOR_VERSION;
  source: 'claude_corpus';
  source_session_id: string;
  source_project: string;
  nca_experiment_phase: ExperimentPhase;
  subagent: boolean;
  event_type: EventType;
  timestamp: string;
  git_branch: string | null;
  source_cwd: string | null;
  // user_prompt_submit only
  prompt_hash?: string;
  prompt_length?: number;
  // post_tool_use only
  tool_name?: string;
  file_path?: string | null;
  // post_tool_use, mcp__nca__nca_ask only (v3+) — derived from the paired
  // tool_result, never persisted as raw text. See nca-ask-result-class.ts:
  // result_classifier records which ruleset produced result_class so
  // historical events are never silently reinterpreted under later rules.
  result_class?: NcaAskResultClass;
  result_classifier?: typeof NCA_ASK_RESULT_CLASSIFIER_VERSION;
}

export interface RunOptions {
  projectName: string;
  projectRoot: string;
  phase: ExperimentPhase;
  since?: string;
  until?: string;
  dryRun?: boolean;
  forceRewrite?: boolean;
  minEventsThreshold?: number;
  includeWorktrees?: boolean;   // default false = main-only (cwd == projectRoot)
  metricsHome?: string; // override output dir for tests (~/.nca/metrics/)
  corpusHome?: string;  // override corpus dir for tests (~/.claude/projects/)
}

export interface SubagentConflict {
  sessionId: string;
  hasAgentPrefix: boolean;
  hasIsSidechain: boolean;
}

export interface SubagentReport {
  byFilenamePrefix: number;
  byIsSidechain: number;
  both: number;
  conflicts: SubagentConflict[];
}

export interface RunReport {
  slug: string;
  corpusDir: string;
  sessionsTotal: number;
  sessionsIncluded: number;
  sessionsExcluded: number;
  exclusionReasons: Record<string, number>;
  eventCounts: Record<EventType, number>;
  totalEvents: number;
  temporalRange: { earliest: string | null; latest: string | null };
  subagentReport: SubagentReport;
  cwdFilterMode: CwdFilterMode;
  cwdEventCounts: Record<string, number>;
  outputPath?: string;
  manifestPath?: string;
}

export interface Manifest {
  schema_version: string;
  extractor_version: string;
  source: string;
  project: string;
  project_root: string;
  corpus_slug: string;
  phase: ExperimentPhase;
  since: string | null;
  until: string | null;
  sessions_seen: number;
  sessions_included: number;
  sessions_excluded: number;
  exclusion_reasons: Record<string, number>;
  event_counts: Record<string, number>;
  temporal_range: { earliest: string | null; latest: string | null };
  subagent_report: SubagentReport;
  cwd_filter_mode: CwdFilterMode;
  cwd_event_counts: Record<string, number>;
  output_path: string;
  output_sha256: string | null;
  generated_at: string;  // extraction run timestamp (volatile; was derived_at in events pre-0.1.1)
  started_at: string;
  completed_at: string;
}
