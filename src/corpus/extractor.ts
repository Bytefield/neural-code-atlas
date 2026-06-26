import { RunOptions, RunReport, Manifest, EventType, SubagentReport, CwdFilterMode, SCHEMA_VERSION, EXTRACTOR_VERSION } from './types.js';
import { resolveProjectSlug } from './slug.js';
import { resolveCorpusDir, readAllSessions, ParsedSession } from './reader.js';
import { deriveSessionEvents } from './events.js';
import { writeOutput, checkExistingVersion, resolveOutputPath, resolveManifestPath } from './writer.js';
import { OrientationEvent } from './types.js';

const SMOKE_DIAG_PATTERN = /smoke|diag|test-session|diagnostic/i;
const DEFAULT_MIN_EVENTS = 5;

// Session-level filter: too few real events means it's likely an aborted/empty session.
// realEventCount = user + assistant events with timestamps (not metadata events like ai-title).
function isTooEmpty(session: ParsedSession, threshold: number): boolean {
  return session.realEventCount < threshold;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function extract(opts: RunOptions): RunReport {
  const {
    projectName,
    projectRoot,
    phase,
    since: sinceStr,
    until: untilStr,
    dryRun = false,
    forceRewrite = false,
    minEventsThreshold = DEFAULT_MIN_EVENTS,
    includeWorktrees = false,
    metricsHome,
    corpusHome,
  } = opts;

  const cwdFilterMode: CwdFilterMode = includeWorktrees ? 'include-worktrees' : 'main-only';

  const since = sinceStr ? new Date(sinceStr) : undefined;
  const until = untilStr ? new Date(untilStr) : undefined;
  const startedAt = new Date().toISOString();

  const slug = resolveProjectSlug(projectRoot);
  const corpusDir = resolveCorpusDir(slug, corpusHome);

  // Version compatibility guard — abort early before doing any work
  if (!dryRun && !forceRewrite) {
    const outputPath = resolveOutputPath(projectName, metricsHome);
    const versionCheck = checkExistingVersion(outputPath);
    if (!versionCheck.compatible) {
      throw new Error(
        `Incompatible output version.\n` +
        `  Found:    schema=${versionCheck.foundSchemaVersion ?? 'unknown'} extractor=${versionCheck.foundExtractorVersion ?? 'unknown'}\n` +
        `  Expected: schema=${SCHEMA_VERSION} extractor=${EXTRACTOR_VERSION}\n` +
        `  Use --force-rewrite to overwrite.`
      );
    }
  }

  // ── Read all sessions from corpus ─────────────────────────────────────────
  const allSessions = readAllSessions(corpusDir);

  const exclusionReasons: Record<string, number> = {};
  const includedSessions: ParsedSession[] = [];
  const subagentReport: SubagentReport = {
    byFilenamePrefix: 0,
    byIsSidechain: 0,
    both: 0,
    conflicts: [],
  };

  for (const session of allSessions) {
    // Track subagent detection signals for the report
    if (session.isAgentPrefixed) subagentReport.byFilenamePrefix++;
    if (session.hasSidechainTrue) subagentReport.byIsSidechain++;
    if (session.isAgentPrefixed && session.hasSidechainTrue) subagentReport.both++;

    // Conflict: signals disagree
    if (session.isAgentPrefixed !== session.hasSidechainTrue) {
      subagentReport.conflicts.push({
        sessionId: session.sessionId,
        hasAgentPrefix: session.isAgentPrefixed,
        hasIsSidechain: session.hasSidechainTrue,
      });
    }

    // Filter: smoke/diag sessions
    if (SMOKE_DIAG_PATTERN.test(session.sessionId)) {
      exclusionReasons['smoke_diag'] = (exclusionReasons['smoke_diag'] ?? 0) + 1;
      continue;
    }

    // Filter: too few real events
    if (isTooEmpty(session, minEventsThreshold)) {
      exclusionReasons['too_few_events'] = (exclusionReasons['too_few_events'] ?? 0) + 1;
      continue;
    }

    includedSessions.push(session);
  }

  // ── Derive events for included sessions ───────────────────────────────────
  const allEvents: OrientationEvent[] = [];
  for (const session of includedSessions) {
    const events = deriveSessionEvents(session, projectName, phase, projectRoot, includeWorktrees, since, until);
    allEvents.push(...events);
  }

  // Deterministic sort: by timestamp, then session_id, then event_id (stable within same ms)
  allEvents.sort((a, b) => {
    const t = a.timestamp.localeCompare(b.timestamp);
    if (t !== 0) return t;
    const s = a.source_session_id.localeCompare(b.source_session_id);
    if (s !== 0) return s;
    return a.event_id.localeCompare(b.event_id);
  });

  // ── Aggregate metrics ─────────────────────────────────────────────────────
  const eventCounts: Record<EventType, number> = {
    session_start: 0,
    user_prompt_submit: 0,
    post_tool_use: 0,
  };
  let earliest: string | null = null;
  let latest: string | null = null;

  const cwdEventCounts: Record<string, number> = {};
  for (const ev of allEvents) {
    eventCounts[ev.event_type]++;
    if (earliest === null || ev.timestamp < earliest) earliest = ev.timestamp;
    if (latest === null || ev.timestamp > latest) latest = ev.timestamp;
    const cwd = ev.source_cwd ?? '(no-cwd)';
    cwdEventCounts[cwd] = (cwdEventCounts[cwd] ?? 0) + 1;
  }

  const totalEvents = allEvents.length;

  // ── Write output (if not dry-run) ─────────────────────────────────────────
  let outputPath: string | undefined;
  let manifestPath: string | undefined;

  if (!dryRun) {
    const completedAt = new Date().toISOString();
    const manifest: Manifest = {
      schema_version: SCHEMA_VERSION,
      extractor_version: EXTRACTOR_VERSION,
      source: 'claude_corpus',
      project: projectName,
      project_root: projectRoot,
      corpus_slug: slug,
      phase,
      since: sinceStr ?? null,
      until: untilStr ?? null,
      sessions_seen: allSessions.length,
      sessions_included: includedSessions.length,
      sessions_excluded: allSessions.length - includedSessions.length,
      exclusion_reasons: exclusionReasons,
      event_counts: eventCounts as unknown as Record<string, number>,
      temporal_range: { earliest, latest },
      subagent_report: subagentReport,
      cwd_filter_mode: cwdFilterMode,
      cwd_event_counts: cwdEventCounts,
      output_path: resolveOutputPath(projectName, metricsHome),
      output_sha256: null, // filled in by writeOutput
      generated_at: startedAt, // extraction run timestamp (volatile; kept in manifest, not in events)
      started_at: startedAt,
      completed_at: completedAt,
    };

    const written = writeOutput(allEvents, manifest, projectName, metricsHome);
    outputPath = written.outputPath;
    manifestPath = written.manifestPath;
  }

  return {
    slug,
    corpusDir,
    sessionsTotal: allSessions.length,
    sessionsIncluded: includedSessions.length,
    sessionsExcluded: allSessions.length - includedSessions.length,
    exclusionReasons,
    eventCounts,
    totalEvents,
    temporalRange: { earliest, latest },
    subagentReport,
    cwdFilterMode,
    cwdEventCounts,
    outputPath,
    manifestPath,
  };
}
