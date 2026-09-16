import { Recommendation } from './types.js';

const TYPE_LABELS: Record<Recommendation['type'], string> = {
  dont_build: "DON'T BUILD",
  do: 'DO',
  fix: 'FIX',
  read_first: 'READ FIRST',
  no_intervention: 'NO INTERVENTION',
  insufficient_evidence: 'INSUFFICIENT EVIDENCE',
};

// A rule with no threshold measures a raw count (e.g. the recall-gap finding),
// never a rate — Number.isInteger(value) can't tell a whole-number RATE (e.g.
// exactly 1.0, all classifiable calls noisy_fallback) from a count, so presence
// of `threshold` is the signal: every rate rule in this methodology carries one.
function fmtValue(value: number | null, hasThreshold: boolean): string {
  if (value === null) return '—';
  return hasThreshold ? (value * 100).toFixed(1) + '%' : String(value);
}

function fmtThreshold(threshold: number | null): string {
  if (threshold === null) return '—';
  return (threshold * 100).toFixed(0) + '%';
}

/**
 * Renders recommendation objects as deterministic Markdown. Never converts
 * evidence_level (a categorical tier) into a numeric confidence percentage —
 * value/threshold are the only percentages here, and only when the underlying
 * metric is itself a rate (integer values, e.g. the recall-gap count, render as
 * plain counts). No wall-clock content — timestamps belong in the run manifest
 * the CLI writes alongside this report, never in the report body itself.
 */
export function renderInsightsMarkdown(
  recommendations: Recommendation[],
  meta: { project: string; scope: string; methodologyVersion: string; vocabularyVersion: number },
): string {
  const lines: string[] = [];
  lines.push(`# NCA Corpus Insights — ${meta.project}`);
  lines.push('');
  lines.push(`Heuristics only. No LLM. Deterministic given the same input events.`);
  lines.push('');
  lines.push(`- scope: \`${meta.scope}\``);
  lines.push(`- methodology_version: \`${meta.methodologyVersion}\``);
  lines.push(`- vocabulary_version: \`${meta.vocabularyVersion}\``);
  lines.push('');

  for (const rec of recommendations) {
    lines.push(`## ${TYPE_LABELS[rec.type]} — ${rec.target}`);
    lines.push('');
    lines.push(`**${rec.finding}**`);
    lines.push('');
    lines.push(`| field | value |`);
    lines.push(`|---|---|`);
    lines.push(`| id | \`${rec.id}\` |`);
    lines.push(`| rule | \`${rec.rule}\` |`);
    lines.push(`| value | ${fmtValue(rec.value, rec.threshold !== null)} |`);
    lines.push(`| threshold | ${fmtThreshold(rec.threshold)} |`);
    lines.push(`| evidence_level | ${rec.evidence_level} |`);
    lines.push(`| expected_effect | ${rec.expected_effect} |`);
    lines.push(`| metric_to_remeasure | \`${rec.metric_to_remeasure}\` |`);
    lines.push(`| expires_when | ${rec.expires_when} |`);
    lines.push('');
    if (rec.evidence.length > 0) {
      lines.push(`Evidence (sample, not exhaustive):`);
      for (const pointer of rec.evidence) lines.push(`- \`${pointer}\``);
      lines.push('');
    }
  }

  return lines.join('\n');
}
