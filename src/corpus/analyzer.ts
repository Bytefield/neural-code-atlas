import * as fs from 'fs';
import * as path from 'path';
import { OrientationEvent, SCHEMA_VERSION } from './types.js';
import { resolveOutputPath, resolveManifestPath } from './writer.js';

// ─── Tool classification ──────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const BASH_TOOL = 'Bash';
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

// v1 decision, not a universal truth — see report output for the value actually used.
export const DEFAULT_DIAGNOSTIC_THRESHOLD = 10;

// ─── Public types ─────────────────────────────────────────────────────────────

export type SessionCategory = 'write' | 'diagnostic' | 'noise';

export interface SessionMetrics {
  source_session_id: string;
  source_cwd: string | null;
  session_start_ts: string | null;
  first_write_ts: string | null;
  has_write: boolean;
  pre_edit_read_tools_count: number;
  pre_edit_all_tools_count: number;
  time_to_first_write_ms: number | null;
  first_write_tool_name: string | null;
  first_write_file_path: string | null;
  // Whole-session tallies — populated regardless of has_write.
  // For no-write sessions these equal the pre_edit_* fields above (no write ever occurs).
  total_tools_count: number;
  read_tools_count: number;
  bash_tools_count: number;
  structured_output_count: number;
  session_duration_ms: number | null;
  tool_counts: Record<string, number>;
}

export interface AggregateMetrics {
  sessions_total: number;
  sessions_with_write: number;
  sessions_without_write: number;
  median_pre_edit_read_tools: number;
  p75_pre_edit_read_tools: number;
  mean_pre_edit_read_tools: number;
  median_pre_edit_all_tools: number;
  p75_pre_edit_all_tools: number;
  mean_pre_edit_all_tools: number;
  median_time_to_first_write_ms: number | null;
  p75_time_to_first_write_ms: number | null;
  top_10_sessions_by_pre_edit_read_tools: SessionMetrics[];
}

export interface DiagnosticAggregateMetrics {
  sessions_total: number;
  median_total_tools: number;
  p75_total_tools: number;
  mean_total_tools: number;
  median_read_tools_total: number;
  p75_read_tools_total: number;
  median_bash_tools_total: number;
  p75_bash_tools_total: number;
  median_session_duration_ms: number | null;
  p75_session_duration_ms: number | null;
  top_tools: Array<{ tool_name: string; count: number }>;
  top_10_diagnostic_sessions_by_total_tools: SessionMetrics[];
}

export interface NoiseSummary {
  sessions_total: number;
  excluded_from_write_track: true;
  excluded_from_diagnostic_track: true;
  // Informative only — StructuredOutput usage SUGGESTS subagent-like activity,
  // it does not prove it. Do not treat this as a confirmed subagent count.
  subagent_like_note: string;
  subagent_like_sessions_count: number;
}

export interface AnalysisReport {
  dataset_path: string;
  manifest_path: string;
  schema_version: string;
  extractor_version: string;
  phase: string;
  cwd_filter_mode: string;
  extractor_sessions_included: number;
  diagnostic_threshold: number;
  sessions: SessionMetrics[];
  aggregate: AggregateMetrics;
  no_write_sessions: SessionMetrics[];
  diagnostic_sessions: SessionMetrics[];
  noise_sessions: SessionMetrics[];
  diagnostic_aggregate: DiagnosticAggregateMetrics;
  noise_summary: NoiseSummary;
}

export interface AnalyzerOptions {
  project: string;
  phase: string;
  inputPath?: string;
  metricsHome?: string;
  diagnosticThreshold?: number;
}

// ─── Statistics helpers ───────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ─── Per-session analysis (pure — no I/O) ─────────────────────────────────────

export function analyzeEvents(events: OrientationEvent[]): {
  sessions: SessionMetrics[];
  no_write_sessions: SessionMetrics[];
} {
  // Group events by source_session_id, preserving arrival order within each group
  const bySession = new Map<string, OrientationEvent[]>();
  for (const ev of events) {
    const bucket = bySession.get(ev.source_session_id);
    if (bucket) {
      bucket.push(ev);
    } else {
      bySession.set(ev.source_session_id, [ev]);
    }
  }

  const sessions: SessionMetrics[] = [];
  const no_write_sessions: SessionMetrics[] = [];

  for (const [sessionId, sessionEvents] of bySession) {
    const sorted = [...sessionEvents].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );

    const startEvent = sorted.find(e => e.event_type === 'session_start');
    const session_start_ts = startEvent?.timestamp ?? sorted[0]?.timestamp ?? null;
    const source_cwd = startEvent?.source_cwd ?? sorted[0]?.source_cwd ?? null;

    // Find the first write event (Edit / MultiEdit / Write)
    let firstWriteIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      if (ev.event_type === 'post_tool_use' && ev.tool_name && WRITE_TOOLS.has(ev.tool_name)) {
        firstWriteIdx = i;
        break;
      }
    }

    const has_write = firstWriteIdx >= 0;
    const firstWriteEvent = has_write ? sorted[firstWriteIdx] : null;

    // Only pre-write events count toward the exploration window
    const preEditTools = sorted
      .slice(0, has_write ? firstWriteIdx : sorted.length)
      .filter(e => e.event_type === 'post_tool_use');

    const pre_edit_read_tools_count = preEditTools.filter(
      e => e.tool_name !== undefined && e.tool_name !== null && READ_TOOLS.has(e.tool_name),
    ).length;
    const pre_edit_all_tools_count = preEditTools.length;

    const time_to_first_write_ms =
      has_write && session_start_ts && firstWriteEvent
        ? new Date(firstWriteEvent.timestamp).getTime() - new Date(session_start_ts).getTime()
        : null;

    // Whole-session tallies (independent of the pre-edit write boundary).
    const allTools = sorted.filter(e => e.event_type === 'post_tool_use');
    const tool_counts: Record<string, number> = {};
    for (const e of allTools) {
      const name = e.tool_name ?? 'unknown';
      tool_counts[name] = (tool_counts[name] ?? 0) + 1;
    }
    const total_tools_count = allTools.length;
    const read_tools_count = allTools.filter(
      e => e.tool_name !== undefined && e.tool_name !== null && READ_TOOLS.has(e.tool_name),
    ).length;
    const bash_tools_count = tool_counts[BASH_TOOL] ?? 0;
    const structured_output_count = tool_counts[STRUCTURED_OUTPUT_TOOL] ?? 0;
    const lastEventTs = sorted.length > 0 ? sorted[sorted.length - 1].timestamp : null;
    const session_duration_ms =
      session_start_ts && lastEventTs
        ? new Date(lastEventTs).getTime() - new Date(session_start_ts).getTime()
        : null;

    const metrics: SessionMetrics = {
      source_session_id: sessionId,
      source_cwd,
      session_start_ts,
      first_write_ts: firstWriteEvent?.timestamp ?? null,
      has_write,
      pre_edit_read_tools_count,
      pre_edit_all_tools_count,
      time_to_first_write_ms,
      first_write_tool_name: firstWriteEvent?.tool_name ?? null,
      first_write_file_path: firstWriteEvent?.file_path ?? null,
      total_tools_count,
      read_tools_count,
      bash_tools_count,
      structured_output_count,
      session_duration_ms,
      tool_counts,
    };

    if (has_write) {
      sessions.push(metrics);
    } else {
      no_write_sessions.push(metrics);
    }
  }

  return { sessions, no_write_sessions };
}

// ─── Aggregate computation ────────────────────────────────────────────────────

function computeAggregate(
  sessions: SessionMetrics[],
  no_write_sessions: SessionMetrics[],
): AggregateMetrics {
  const readCounts = [...sessions.map(s => s.pre_edit_read_tools_count)].sort((a, b) => a - b);
  const allCounts = [...sessions.map(s => s.pre_edit_all_tools_count)].sort((a, b) => a - b);
  const ttfwValues = sessions
    .filter(s => s.time_to_first_write_ms !== null)
    .map(s => s.time_to_first_write_ms as number)
    .sort((a, b) => a - b);

  return {
    sessions_total: sessions.length + no_write_sessions.length,
    sessions_with_write: sessions.length,
    sessions_without_write: no_write_sessions.length,
    median_pre_edit_read_tools: percentile(readCounts, 50),
    p75_pre_edit_read_tools: percentile(readCounts, 75),
    mean_pre_edit_read_tools: mean(readCounts),
    median_pre_edit_all_tools: percentile(allCounts, 50),
    p75_pre_edit_all_tools: percentile(allCounts, 75),
    mean_pre_edit_all_tools: mean(allCounts),
    median_time_to_first_write_ms: ttfwValues.length > 0 ? percentile(ttfwValues, 50) : null,
    p75_time_to_first_write_ms: ttfwValues.length > 0 ? percentile(ttfwValues, 75) : null,
    top_10_sessions_by_pre_edit_read_tools: [...sessions]
      .sort((a, b) => b.pre_edit_read_tools_count - a.pre_edit_read_tools_count)
      .slice(0, 10),
  };
}

// ─── Carril B — diagnostic / noise classification (no-write sessions) ────────

// Splits no-write sessions into "diagnostic" (real orientation activity, no edit)
// and "noise" (low-activity, subagent-like) populations using diagnosticThreshold
// on total_tools_count. This is a v1 heuristic, not a semantic classifier.
export function classifyNoWriteSessions(
  no_write_sessions: SessionMetrics[],
  diagnosticThreshold: number,
): { diagnostic_sessions: SessionMetrics[]; noise_sessions: SessionMetrics[] } {
  const diagnostic_sessions: SessionMetrics[] = [];
  const noise_sessions: SessionMetrics[] = [];
  for (const s of no_write_sessions) {
    if (s.total_tools_count >= diagnosticThreshold) {
      diagnostic_sessions.push(s);
    } else {
      noise_sessions.push(s);
    }
  }
  return { diagnostic_sessions, noise_sessions };
}

function computeDiagnosticAggregate(diagnostic_sessions: SessionMetrics[]): DiagnosticAggregateMetrics {
  const totalCounts = diagnostic_sessions.map(s => s.total_tools_count).sort((a, b) => a - b);
  const readCounts = diagnostic_sessions.map(s => s.read_tools_count).sort((a, b) => a - b);
  const bashCounts = diagnostic_sessions.map(s => s.bash_tools_count).sort((a, b) => a - b);
  const durations = diagnostic_sessions
    .filter(s => s.session_duration_ms !== null)
    .map(s => s.session_duration_ms as number)
    .sort((a, b) => a - b);

  const toolTotals = new Map<string, number>();
  for (const s of diagnostic_sessions) {
    for (const [name, count] of Object.entries(s.tool_counts)) {
      toolTotals.set(name, (toolTotals.get(name) ?? 0) + count);
    }
  }
  const top_tools = [...toolTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool_name, count]) => ({ tool_name, count }));

  return {
    sessions_total: diagnostic_sessions.length,
    median_total_tools: percentile(totalCounts, 50),
    p75_total_tools: percentile(totalCounts, 75),
    mean_total_tools: mean(totalCounts),
    median_read_tools_total: percentile(readCounts, 50),
    p75_read_tools_total: percentile(readCounts, 75),
    median_bash_tools_total: percentile(bashCounts, 50),
    p75_bash_tools_total: percentile(bashCounts, 75),
    median_session_duration_ms: durations.length > 0 ? percentile(durations, 50) : null,
    p75_session_duration_ms: durations.length > 0 ? percentile(durations, 75) : null,
    top_tools,
    top_10_diagnostic_sessions_by_total_tools: [...diagnostic_sessions]
      .sort((a, b) => b.total_tools_count - a.total_tools_count)
      .slice(0, 10),
  };
}

function computeNoiseSummary(noise_sessions: SessionMetrics[]): NoiseSummary {
  const subagent_like_sessions_count = noise_sessions.filter(
    s => s.structured_output_count > 0,
  ).length;

  return {
    sessions_total: noise_sessions.length,
    excluded_from_write_track: true,
    excluded_from_diagnostic_track: true,
    subagent_like_note:
      'StructuredOutput usage suggests subagent-like activity; it does not prove it. ' +
      'This is an informative signal, not a filter or an absolute classification.',
    subagent_like_sessions_count,
  };
}

// ─── CSV export ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'source_session_id',
  'source_cwd',
  'session_start_ts',
  'first_write_ts',
  'has_write',
  'pre_edit_read_tools_count',
  'pre_edit_all_tools_count',
  'time_to_first_write_ms',
  'first_write_tool_name',
  'first_write_file_path',
] as const;

function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function toCSV(sessions: SessionMetrics[]): string {
  const rows = [CSV_HEADERS.join(',')];
  for (const s of sessions) {
    rows.push([
      s.source_session_id,
      s.source_cwd,
      s.session_start_ts,
      s.first_write_ts,
      s.has_write,
      s.pre_edit_read_tools_count,
      s.pre_edit_all_tools_count,
      s.time_to_first_write_ms,
      s.first_write_tool_name,
      s.first_write_file_path,
    ].map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

// ─── File I/O helpers ─────────────────────────────────────────────────────────

function readEventsFromFile(jsonlPath: string): OrientationEvent[] {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const events: OrientationEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as OrientationEvent);
    } catch {
      // skip malformed lines — extractor writes atomically so this is unexpected
    }
  }
  return events;
}

interface ManifestFields {
  schema_version: string;
  extractor_version: string;
  phase: string;
  cwd_filter_mode: string;
  sessions_included: number;
}

function readManifest(manifestPath: string): ManifestFields {
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(raw) as ManifestFields;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function analyze(opts: AnalyzerOptions): AnalysisReport {
  const { project, phase, inputPath, metricsHome } = opts;
  const diagnosticThreshold = opts.diagnosticThreshold ?? DEFAULT_DIAGNOSTIC_THRESHOLD;

  const jsonlPath = inputPath ?? resolveOutputPath(project, metricsHome);
  const manifestPath = inputPath
    ? inputPath.replace(/\.jsonl$/, '.manifest.json')
    : resolveManifestPath(project, metricsHome);

  if (!fs.existsSync(jsonlPath)) {
    throw new Error(
      `Orientation events file not found: ${jsonlPath}\n` +
      `Run 'nca corpus extract --project ${project} --project-root <path> --phase ${phase}' first.`,
    );
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = readManifest(manifestPath);

  // Schema guard — abort early with a clear message
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Incompatible schema_version in manifest: found '${manifest.schema_version}', ` +
      `expected '${SCHEMA_VERSION}'.\n` +
      `Re-run 'nca corpus extract --force-rewrite' to regenerate with current schema.`,
    );
  }

  const rawEvents = readEventsFromFile(jsonlPath);
  if (rawEvents.length === 0) {
    throw new Error(`No events found in: ${jsonlPath}`);
  }

  // Validate every event's schema_version (first event is sufficient proxy, but be explicit)
  const badSchema = rawEvents.find(e => e.schema_version !== SCHEMA_VERSION);
  if (badSchema) {
    throw new Error(
      `Event schema_version mismatch: found '${badSchema.schema_version}' in event ` +
      `${badSchema.event_id}, expected '${SCHEMA_VERSION}'.\n` +
      `Re-run 'nca corpus extract --force-rewrite'.`,
    );
  }

  const { sessions, no_write_sessions } = analyzeEvents(rawEvents);
  const sessions_total = sessions.length + no_write_sessions.length;

  // Sanity check: distinct sessions in JSONL must match manifest's sessions_included
  if (sessions_total !== manifest.sessions_included) {
    throw new Error(
      `Session count mismatch: analyzer found ${sessions_total} distinct sessions, ` +
      `but manifest reports sessions_included=${manifest.sessions_included}.\n` +
      `The JSONL may be inconsistent with the manifest — re-run 'nca corpus extract'.`,
    );
  }

  const aggregate = computeAggregate(sessions, no_write_sessions);
  const { diagnostic_sessions, noise_sessions } = classifyNoWriteSessions(
    no_write_sessions,
    diagnosticThreshold,
  );
  const diagnostic_aggregate = computeDiagnosticAggregate(diagnostic_sessions);
  const noise_summary = computeNoiseSummary(noise_sessions);

  return {
    dataset_path: jsonlPath,
    manifest_path: manifestPath,
    schema_version: manifest.schema_version,
    extractor_version: manifest.extractor_version,
    phase: manifest.phase ?? phase,
    cwd_filter_mode: manifest.cwd_filter_mode,
    extractor_sessions_included: manifest.sessions_included,
    diagnostic_threshold: diagnosticThreshold,
    sessions,
    aggregate,
    no_write_sessions,
    diagnostic_sessions,
    noise_sessions,
    diagnostic_aggregate,
    noise_summary,
  };
}
