import * as fs from 'fs';
import * as path from 'path';
import { OrientationEvent, SCHEMA_VERSION } from './types.js';
import { resolveOutputPath, resolveManifestPath } from './writer.js';

// ─── Tool classification ──────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

// ─── Public types ─────────────────────────────────────────────────────────────

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

export interface AnalysisReport {
  dataset_path: string;
  manifest_path: string;
  schema_version: string;
  extractor_version: string;
  phase: string;
  cwd_filter_mode: string;
  extractor_sessions_included: number;
  sessions: SessionMetrics[];
  aggregate: AggregateMetrics;
  no_write_sessions: SessionMetrics[];
}

export interface AnalyzerOptions {
  project: string;
  phase: string;
  inputPath?: string;
  metricsHome?: string;
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

  return {
    dataset_path: jsonlPath,
    manifest_path: manifestPath,
    schema_version: manifest.schema_version,
    extractor_version: manifest.extractor_version,
    phase: manifest.phase ?? phase,
    cwd_filter_mode: manifest.cwd_filter_mode,
    extractor_sessions_included: manifest.sessions_included,
    sessions,
    aggregate,
    no_write_sessions,
  };
}
