// Recommendation object shape — frozen 2026-09-15 (roadmap §Phase B, Contract §11
// Scope & Provenance). `confidence` in the roadmap's illustrative JSON is the same
// field as `evidence_level` here; the frozen Scope & Provenance block spells out the
// full enum tokens (EVIDENCE_STRONG/EVIDENCE_MODERATE/EVIDENCE_WEAK/INSUFFICIENT),
// which is what this file uses.

export const VOCABULARY_VERSION = 1;
export const METHODOLOGY_VERSION = '1';

export type RecommendationType =
  | 'dont_build'
  | 'do'
  | 'fix'
  | 'read_first'
  | 'no_intervention'
  | 'insufficient_evidence';

export type EvidenceLevel =
  | 'EVIDENCE_STRONG'
  | 'EVIDENCE_MODERATE'
  | 'EVIDENCE_WEAK'
  | 'INSUFFICIENT';

export interface Recommendation {
  vocabulary_version: number;
  project_id: string;
  id: string;
  type: RecommendationType;
  target: string;
  finding: string;
  task_class: null;
  value: number | null;
  threshold: number | null;
  rule: string;
  evidence: string[];
  evidence_level: EvidenceLevel;
  scope: string;
  expected_effect: string;
  metric_to_remeasure: string;
  expires_when: string;
  methodology_version: string;
}

// Evidence-level tiering is v1's own, explicit and revisable — the roadmap defines
// the enum but not a sample-size mapping. Boundaries are a first-pass calibration:
// the 3 known-decision populations anchor it (P4a ~743, Brief ~688 -> STRONG;
// nca_ask ~64 -> MODERATE, a real but modest sample per REC-0001's own "48/64"
// framing). Revisit once more corpora exist to calibrate against.
export function evidenceLevelForSampleSize(n: number): EvidenceLevel {
  if (n <= 0) return 'INSUFFICIENT';
  if (n < 30) return 'EVIDENCE_WEAK';
  if (n < 100) return 'EVIDENCE_MODERATE';
  return 'EVIDENCE_STRONG';
}
