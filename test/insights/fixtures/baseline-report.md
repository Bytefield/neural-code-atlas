# NCA Corpus Insights — synio

Heuristics only. No LLM. Deterministic given the same input events.

- scope: `synio/main-only`
- methodology_version: `1`
- vocabulary_version: `1`

## DON'T BUILD — session_memory

**avoidable_reread**

| field | value |
|---|---|
| id | `INSIGHT-P4A-REREAD-V1` |
| rule | `REREAD_MEMORY_V1` |
| value | 21.1% |
| threshold | 40% |
| evidence_level | EVIDENCE_STRONG |
| expected_effect | reduce redundant cross-session Read calls on the same file |
| metric_to_remeasure | `median_pre_edit_read_tools` |
| expires_when | next full corpus re-extraction for this project, or methodology_version bumps |

Evidence (sample, not exhaustive):
- `file:/mnt/c/dev/synio/.husky/pre-push`
- `file:/mnt/c/dev/synio/jest.config.unit.js`
- `file:/mnt/c/dev/synio/src/server/trpc/routers/synio/company.ts`
- `file:/mnt/c/dev/synio/src/lib/security/rls.ts`
- `file:/mnt/c/dev/synio/jest.config.js`

## DON'T BUILD — brief_injection

**search_first_action_rate**

| field | value |
|---|---|
| id | `INSIGHT-BRIEF-SEARCH-FIRST-V1` |
| rule | `SEARCH_FIRST_ACTION_V1` |
| value | 18.0% |
| threshold | 30% |
| evidence_level | EVIDENCE_STRONG |
| expected_effect | reduce orientation reads by pre-injecting relevant context at prompt time |
| metric_to_remeasure | `search_first_action_rate` |
| expires_when | next full corpus re-extraction for this project, or methodology_version bumps |

Evidence (sample, not exhaustive):
- `session:ba33426b-4024-4adc-88b4-cf53e113009e`
- `session:0ca4208e-5b6a-4003-9dd6-72ff4a37d3ac`
- `session:7e4c69d8-a012-488f-8b0a-08d7d20b070d`
- `session:80553728-e6c0-49b9-8d29-6b815983db3d`
- `session:43ce5d64-6ef2-46fd-af84-51c005ee73c2`

## INSUFFICIENT EVIDENCE — nca_ask_matcher

**noisy_fallback_dominant**

| field | value |
|---|---|
| id | `INSIGHT-NCA-ASK-RELIABILITY-V1` |
| rule | `NCA_ASK_NOISY_FALLBACK_V1` |
| value | — |
| threshold | 40% |
| evidence_level | INSUFFICIENT |
| expected_effect | reduce noisy_fallback share of nca_ask responses |
| metric_to_remeasure | `nca_ask_noisy_fallback_rate` |
| expires_when | classifier version bumps, or methodology_version bumps |

## NO INTERVENTION — nca_ask_matcher

**source_text_present_but_not_retrieved**

| field | value |
|---|---|
| id | `INSIGHT-NCA-ASK-RECALL-V1` |
| rule | `NCA_ASK_RECALL_GAP_V1` |
| value | 26 |
| threshold | — |
| evidence_level | EVIDENCE_MODERATE |
| expected_effect | not evaluated — recorded pending a decision on whether recall deserves investment |
| metric_to_remeasure | `replay_recall_gap_count` |
| expires_when | a Replay A/B re-run after a matcher/indexer change, or Phase B explicitly decides on recall |

Evidence (sample, not exhaustive):
- `file:test/replay/recall-subclassification.md`
- `file:test/replay/rootcause-2gaps.md`
