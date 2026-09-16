import * as crypto from 'crypto';
import { SCHEMA_VERSION, EXTRACTOR_VERSION, ExperimentPhase, EventType, OrientationEvent } from './types.js';
import { RawLine, RawContentBlock, RawToolUseBlock, RawToolResultBlock, ParsedSession } from './reader.js';
import { classifyNcaAskResult, NCA_ASK_RESULT_CLASSIFIER_VERSION, McpResponseLike } from './nca-ask-result-class.js';

const NCA_ASK_TOOL_NAME = 'mcp__nca__nca_ask';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256short(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

// event_id is deterministic across runs for the same logical event.
// Components: project + session + timestamp + event_type + disambiguator.
// tool_use_id is preferred disambiguator for post_tool_use (stable if Claude reuses IDs).
// sequence_index is fallback (based on position in session line order).
function makeEventId(
  sourceProject: string,
  sessionId: string,
  timestamp: string,
  eventType: EventType,
  disambiguator: string,
): string {
  return sha256short([sourceProject, sessionId, timestamp, eventType, disambiguator].join('|'));
}

// ─── Content analysis ─────────────────────────────────────────────────────────

// A line is a "tool result response" if ALL content blocks are tool_result.
// These are not real user prompts — they are the user-side delivery of tool output.
function isToolResultResponse(line: RawLine): boolean {
  const content = line.message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return (content as RawContentBlock[]).every(b => (b as { type: string }).type === 'tool_result');
}

// Extract the text of a real user prompt. Returns null if not a real prompt.
// Never returns raw text — callers hash it immediately.
function extractUserPromptText(line: RawLine): string | null {
  const content = line.message?.content;
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const textBlocks = (content as RawContentBlock[]).filter(
    b => (b as { type: string }).type === 'text'
  ) as Array<{ type: 'text'; text: string }>;
  if (textBlocks.length === 0) return null;
  return textBlocks.map(b => b.text).join('\n');
}

// ─── nca_ask result classification (scope: mcp__nca__nca_ask post_tool_use only) ──

// Builds tool_use_id -> tool_result block for every tool_result in the session,
// once per session, so the post_tool_use loop below does O(1) lookups instead of
// rescanning session.lines per tool call. Scans all lines regardless of the
// tool_use/tool_result ordering the corpus happens to use.
function indexToolResultsByUseId(session: ParsedSession): Map<string, RawToolResultBlock> {
  const index = new Map<string, RawToolResultBlock>();
  for (const line of session.lines) {
    if (line.type !== 'user') continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as RawContentBlock[]) {
      if ((block as { type: string }).type !== 'tool_result') continue;
      const tr = block as RawToolResultBlock;
      if (typeof tr.tool_use_id === 'string') index.set(tr.tool_use_id, tr);
    }
  }
  return index;
}

// Adapts a transcript tool_result block (Claude Code JSONL shape) into the
// McpResponseLike shape classifyNcaAskResult() expects (live MCP JSON-RPC
// response shape). The two are structurally different envelopes around the
// same underlying MCP content — this only reshapes, it does not reinterpret.
// The returned object (and everything derived from it) is used transiently
// to compute result_class; it is never attached to an event or persisted.
function toolResultBlockToMcpResponseLike(block: RawToolResultBlock): McpResponseLike {
  const content = block.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Array<{ type?: string; text?: string }>).find(b => b && b.type === 'text')?.text
      : undefined;
  if (block.is_error === true) {
    return { error: { message: text } };
  }
  return { result: { content: [{ text }] } };
}

// ─── Per-event gitBranch ─────────────────────────────────────────────────────

function getLineBranch(line: RawLine, sessionDefault: string | null): string | null {
  if (typeof line.gitBranch === 'string') return line.gitBranch;
  return sessionDefault;
}

// ─── Derivation ──────────────────────────────────────────────────────────────

export function deriveSessionEvents(
  session: ParsedSession,
  sourceProject: string,
  phase: ExperimentPhase,
  projectRoot: string,
  includeWorktrees: boolean,
  since?: Date,
  until?: Date,
): OrientationEvent[] {
  const events: OrientationEvent[] = [];
  const isSubagent = session.isAgentPrefixed || session.hasSidechainTrue;
  let sessionStartEmitted = false;
  let sequenceIndex = 0;
  const toolResultsByUseId = indexToolResultsByUseId(session);

  for (const line of session.lines) {
    const ts = typeof line.timestamp === 'string' ? line.timestamp : null;
    if (!ts) continue;

    // cwd filter: in main-only mode, skip events from worktrees or unknown cwd
    const lineCwd = typeof line.cwd === 'string' && line.cwd ? line.cwd : null;
    if (!includeWorktrees && lineCwd !== projectRoot) continue;

    // Time-range filter
    const lineDate = new Date(ts);
    if (since && lineDate < since) continue;
    if (until && lineDate > until) continue;

    const gitBranch = getLineBranch(line, session.sessionGitBranch);
    // All fields here must be deterministic (corpus-derived or constant) so that
    // re-running the extractor on the same corpus produces identical JSONL bytes.
    const baseFields = {
      schema_version: SCHEMA_VERSION,
      extractor_version: EXTRACTOR_VERSION,
      source: 'claude_corpus' as const,
      source_session_id: session.sessionId,
      source_project: sourceProject,
      nca_experiment_phase: phase,
      subagent: isSubagent,
      git_branch: gitBranch,
      source_cwd: lineCwd,
    };

    // session_start: first timestamped event in the session
    if (!sessionStartEmitted) {
      sessionStartEmitted = true;
      events.push({
        ...baseFields,
        event_id: makeEventId(sourceProject, session.sessionId, ts, 'session_start', String(sequenceIndex)),
        event_type: 'session_start',
        timestamp: ts,
      });
      sequenceIndex++;
    }

    // user_prompt_submit: user events with real prompt text
    if (line.type === 'user' && !isToolResultResponse(line)) {
      const promptText = extractUserPromptText(line);
      if (promptText !== null) {
        events.push({
          ...baseFields,
          event_id: makeEventId(sourceProject, session.sessionId, ts, 'user_prompt_submit', String(sequenceIndex)),
          event_type: 'user_prompt_submit',
          timestamp: ts,
          // Privacy: hash only, never raw text
          prompt_hash: sha256short(promptText),
          prompt_length: promptText.length,
        });
        sequenceIndex++;
      }
    }

    // post_tool_use: each tool_use block in assistant messages
    if (line.type === 'assistant') {
      const content = line.message?.content;
      if (Array.isArray(content)) {
        let toolIndex = 0;
        for (const block of content as RawContentBlock[]) {
          if ((block as { type: string }).type !== 'tool_use') continue;
          const tb = block as RawToolUseBlock;
          const toolName = typeof tb.name === 'string' ? tb.name : undefined;
          const input = tb.input ?? {};
          const filePath = (
            (input['file_path'] as string | undefined) ??
            (input['path'] as string | undefined) ??
            null
          );
          // tool_use_id preferred as disambiguator for stability; fallback to seq+offset
          const disambiguator = typeof tb.id === 'string'
            ? tb.id
            : `${sequenceIndex}:${toolIndex}`;

          const event: OrientationEvent = {
            ...baseFields,
            event_id: makeEventId(sourceProject, session.sessionId, ts, 'post_tool_use', disambiguator),
            event_type: 'post_tool_use',
            timestamp: ts,
            tool_name: toolName,
            file_path: filePath,
          };

          // Scope (condition 3): result_class exists ONLY on mcp__nca__nca_ask
          // post_tool_use events. The paired tool_result's text is read only
          // transiently, inside classifyNcaAskResult()/this adapter — it is
          // never assigned to a field, logged, or otherwise persisted here.
          if (toolName === NCA_ASK_TOOL_NAME && typeof tb.id === 'string') {
            const resultBlock = toolResultsByUseId.get(tb.id);
            if (resultBlock) {
              const { cls } = classifyNcaAskResult(toolResultBlockToMcpResponseLike(resultBlock));
              event.result_class = cls;
              event.result_classifier = NCA_ASK_RESULT_CLASSIFIER_VERSION;
            }
          }

          events.push(event);
          toolIndex++;
        }
        sequenceIndex += toolIndex || 1;
      }
    }
  }

  return events;
}
