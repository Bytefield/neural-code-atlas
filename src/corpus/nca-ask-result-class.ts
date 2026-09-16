/**
 * Single source of truth for classifying an `mcp__nca__nca_ask` tool result.
 *
 * Originally lived only in test/replay/run.js (the frozen replay harness).
 * Moved here unchanged so the corpus extractor's result_class field (see
 * events.ts) and the replay harness apply the exact same rules — never two
 * independently-maintained copies that could drift. Semantics must not
 * change by moving; test/replay/run.js re-exports classify()/normalizeOutput()
 * from here, and both replay --check runs (September index, Replay A June
 * index) verified byte-identical classifications immediately after the move.
 *
 * NCA_ASK_RESULT_CLASSIFIER_VERSION is a distinct axis from schema_version:
 * the event schema (what fields exist) and the classifier's rules (how
 * result_class is computed from a tool_result) evolve independently. Every
 * event carrying a result_class also carries the classifier version that
 * produced it, so historical events are never silently reinterpreted under
 * newer rules — a rule change bumps this constant, not schema_version.
 */

export const NCA_ASK_RESULT_CLASSIFIER_VERSION = 'NCA_ASK_RESULT_V1' as const;

export type NcaAskResultClass =
  | 'direct_hit'
  | 'clean_no_match'
  | 'noisy_fallback'
  | 'known_env_error'
  | 'product_error';

/** Shape common to both the live MCP JSON-RPC response and a transcript's tool_result block. */
export interface McpResponseLike {
  error?: { message?: string } | null;
  result?: { content?: Array<{ text?: string }> } | null;
}

// Recognizes the current SchemaVersionSkewError message (#55), its pre-#55 raw
// form, and the missing-index error — all environment conditions, not product defects.
export const KNOWN_ENV_ERROR_RE =
  /NCA schema version mismatch|schema_version \(\d+\) is newer than this build supports|No NCA index found/;

/**
 * Strips wall-clock-derived content so classification/comparison is
 * deterministic across runs and across time (see
 * test/fixtures/replay/manifest.json:harness.determinism_normalization).
 */
export function normalizeNcaAskOutput(text: unknown): string {
  if (typeof text !== 'string') return text as string;
  return text
    .replace(/\|t:\d+/g, '|t:<TS>')
    .replace(/Index is \d+ days old/g, 'Index is <DAYS> days old');
}

/**
 * Classifies one nca_ask response. Two no-match message formats appear
 * across the corpus: the current "no matches for '<query>'" phrasing, and a
 * legacy "(no results)" line (an older nca_ask build, predates even the
 * current wording — recognizing only the current phrasing silently
 * miscounted historical no-match responses as direct_hit; see PR #58).
 */
export function classifyNcaAskResult(response: McpResponseLike | null | undefined): { cls: NcaAskResultClass; detail: string } {
  if (!response) {
    return { cls: 'product_error', detail: 'no response received' };
  }
  if (response.error) {
    const message = response.error.message ?? '';
    if (KNOWN_ENV_ERROR_RE.test(message)) {
      return { cls: 'known_env_error', detail: normalizeNcaAskOutput(message) };
    }
    return { cls: 'product_error', detail: normalizeNcaAskOutput(message) };
  }
  const text = response.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    return { cls: 'product_error', detail: `malformed success response: ${JSON.stringify(response).slice(0, 300)}` };
  }
  const norm = normalizeNcaAskOutput(text);
  const isNoMatch = /no matches for '|^\(no results\)$/m.test(norm);
  if (!isNoMatch) {
    return { cls: 'direct_hit', detail: norm };
  }
  const hasFlowContent = norm.includes('[F]') || /#[^\s[]+\[/.test(norm);
  return { cls: hasFlowContent ? 'noisy_fallback' : 'clean_no_match', detail: norm };
}
