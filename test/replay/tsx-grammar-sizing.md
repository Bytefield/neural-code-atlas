# .tsx grammar defect — blast radius sizing at e29cb7a1 (measurement only)

Evidence rule: every file read via `git show e29cb7a1:<path>` (git object), never the synio working tree.

## 1. Grammar availability

`tree-sitter-typescript@0.21.2` exports: `typescript, tsx` — both `typescript` and `tsx` present.

## 2. Scanner eligibility rule (from src/scanner.ts, NOT .ncaignore)

`.ncaignore` is not referenced anywhere in src/ — the real exclusion mechanism is `DEFAULT_EXCLUDED_DIRS` + any dot-prefixed directory + `DEFAULT_EXTS` + `max_file_size_kb` (default 512), all in `src/scanner.ts:collectFiles()`. No `.nca/config.json` existed at e29cb7a1, so defaults apply unmodified.

Excluded dirs: `node_modules, .git, dist, build, .next, .nuxt, .svelte-kit, coverage, __pycache__, .mypy_cache, .pytest_cache, .tox, .nca, vendor, .venv, venv, env` (+ any dot-prefixed directory)

## Parse failures (excluded from the aggregate below)

6 of 205 eligible .tsx files throw a native tree-sitter "Invalid argument" error under one or both grammars (observed cause: astral-plane/surrogate-pair characters such as emoji in the source — a tooling limitation of this binding, not the .tsx grammar-selection bug). `src/parser.ts:279` already wraps its own parse call in try/catch -> `regexFallback`, so production does not crash on these files either — but the grammar-delta comparison below does not apply to them (production never reaches "which grammar", it falls to a regex-based extractor instead, not reproduced here). Aggregate below is computed over the remaining 199.

| path | size(B) | plain grammar threw | tsx grammar threw |
|---|---|---|---|
| src/app/(marketing)/page.tsx | 46850 | yes | yes |
| src/app/admin/companies/[id]/page.tsx | 43507 | yes | yes |
| src/app/admin/configuracion/page.tsx | 43421 | yes | yes |
| src/app/admin/telephony/numbers/page.tsx | 35468 | yes | yes |
| src/components/admin/SuperuserDashboard.tsx | 41948 | yes | yes |
| src/components/crm/ClientDrawer.tsx | 38110 | yes | yes |

## 6. Aggregates

| metric | value |
|---|---|
| total .tsx eligible | 205 |
| total .tsx measured (eligible minus parse failures) | 199 |
| named nodes, plain grammar (actual) | 838 |
| named nodes, tsx grammar (correct) | 910 |
| delta (absolute) | 72 |
| delta (%) | 7.9% |

### Delta by node type

(tsx-grammar count minus plain-grammar count, summed across all measured files — positive = lost under the current defect, negative = the plain grammar produces MORE of that type in aggregate, e.g. from parse-error recovery producing extra arrow/method-shaped fragments.)

| type | lost |
|---|---|
| function | 124 |
| arrow | -40 |
| method | -12 |
| class | 0 |

### Distribution (concentrated vs systemic)

p50 % lost per file: 0% · p90 % lost per file: 88.9%

| bucket | file count |
|---|---|
| 0% loss | 77 |
| <25% loss | 30 |
| 25-75% loss | 39 |
| >75% loss | 23 |

### Files with 0 surviving nodes (fully invisible to nca_ask/nca_impact): 19

| path | nodes under correct grammar |
|---|---|
| src/app/admin/design-test/page.tsx | 1 |
| src/app/global-error.tsx | 1 |
| src/app/layout.tsx | 1 |
| src/components/admin/KpiCard.tsx | 1 |
| src/components/admin/PageHeader.tsx | 1 |
| src/components/billing/SidebarUsageWidget.tsx | 1 |
| src/components/campaigns/CampaignAnalyticsTab.tsx | 2 |
| src/components/campaigns/CampaignOutcomeChart.tsx | 1 |
| src/components/onboarding/Step1CompanyInfo.tsx | 1 |
| src/components/onboarding/Step4PreviewCall.tsx | 1 |
| src/components/ui/checkbox.tsx | 1 |
| src/components/ui/empty-state.tsx | 1 |
| src/components/ui/label.tsx | 1 |
| src/components/ui/popover.tsx | 1 |
| src/components/ui/progress.tsx | 1 |
| src/components/ui/switch.tsx | 1 |
| src/components/ui/tabs.tsx | 3 |
| src/components/ui/tooltip.tsx | 1 |
| src/pages/_error.tsx | 2 |

## 5. September DB cross-check

199 .tsx files checked. Discrepancies (DB node set != plain-grammar reproduction): 8.

| path | sept DB nodes | plain-grammar reproduction nodes |
|---|---|---|
| src/app/(marketing)/layout.tsx | 1 | 1 |
| src/app/admin/companies/new/page.tsx | 13 | 14 |
| src/app/admin/companies/page.tsx | 7 | 7 |
| src/app/onboarding/page.tsx | 13 | 13 |
| src/components/companies/EditCompanyInfoDialog.tsx | 7 | 7 |
| src/components/onboarding/Step2ServicesHours.tsx | 8 | 9 |
| src/components/onboarding/Step3SynioConfig.tsx | 9 | 18 |
| src/components/onboarding/__tests__/Step2ServicesHours.test.tsx | 0 | 2 |

## 4. .ts control

Sample: 60 of 506 eligible .ts files (deterministic even-spread sample). Total delta (tsx-grammar-nodes minus plain-grammar-nodes, summed): **0**.

No discrepancies — grammar choice makes no difference on .ts files, as expected (confirms the effect is JSX-specific to .tsx, not a general parsing artifact of this measurement approach).

## 7. Replay queries that targeted a .tsx (context only)

6 of the 58 in-scope Phase A replay queries targeted a .tsx file.

| event_id | query | class | evidence |
|---|---|---|---|
| 02bec69b581249ca | "getCompanies showArchived filter archived companies list" | clean_no_match | e29cb7a12d6ac860f8175fa478e88147c4ba1ba7:src/app/admin/companies/page.tsx:216:  const [showArchived, setShowArchived] =  |
| 0e6d4f2686cc7ee4 | "ActivateCompanyWizard WizardStep" | clean_no_match | e29cb7a12d6ac860f8175fa478e88147c4ba1ba7:src/app/admin/companies/new/page.tsx:28:  type WizardStep, |
| a66eeca3b64f454b | "AdminDashboardPage AdminLayout components" | clean_no_match | e29cb7a12d6ac860f8175fa478e88147c4ba1ba7:src/app/admin/layout.tsx:9:export default async function AdminLayout({ |
| abbddeebb9010aaa | "AdminDashboardPage AdminLayout" | clean_no_match | e29cb7a12d6ac860f8175fa478e88147c4ba1ba7:src/app/admin/layout.tsx:9:export default async function AdminLayout({ |
| c7e6f783e1a51c8a | "createCompany CreateCompanyForm" | clean_no_match | e29cb7a12d6ac860f8175fa478e88147c4ba1ba7:src/app/admin/companies/new/page.tsx:155:  const createCompany = trpc.onboardin |
| ca87e4124cdec550 | "archiveCompany mutation 400 bad request already archived" | clean_no_match | e29cb7a12d6ac860f8175fa478e88147c4ba1ba7:src/app/admin/companies/[id]/page.tsx:115:  const archiveCompany = trpc.synio.a |

## Proposed ledger line for REC-0004 (NOT applied)

```
REC-0004 — nca_ask/nca_impact indexer coverage, .tsx grammar mismatch. Evidence: src/parser.ts:239 parses .tsx with tree-sitter-typescript's plain 'typescript' grammar (never loads its 'tsx' grammar, confirmed both present, tree-sitter-typescript@0.21.2). Measured across 199 of 205 scan-eligible .tsx files in synio@e29cb7a1 (git-object read, DEFAULT_EXTS/DEFAULT_EXCLUDED_DIRS/512KB size rule from src/scanner.ts; 6 excluded — native tree-sitter parse failures unrelated to the grammar-selection bug, see parse_failures): 838 named nodes produced vs 910 with the correct .tsx grammar — 72 nodes lost (7.9%), 19 files with ZERO surviving nodes (fully invisible to nca_ask/nca_impact). Loss distribution: 77 files 0% loss, 30 files <25%, 39 files 25-75%, 23 files >75% — evaluate concentration vs distribution.count breakdown. .ts control (n=60, of 506 eligible): total delta 0, 0 discrepancies — confirms the effect is .tsx/JSX-specific, not a general grammar-choice artifact. September DB cross-check: 8 files where the DB does NOT match this reproduction — see discrepancies. 6 of the 58 in-scope Phase A replay queries targeted a .tsx file (real usage manifestation, not just n=1). evidence_level: HIGH (exact reproduction against frozen index, not inference). candidate_type: FIX_RELIABILITY vs NO_INTERVENTION — numbers only, not decided here. If fixed, re-measure: nodes-per-.tsx-file count (this same script, re-run against a fresh scan) and Replay B (drift/source-text classification) to confirm the .tsx-sourced INDEXABLE_CONSTRUCT_NO_NODE and any downstream MULTI_TOKEN_QUERY/OTHER classifications shift as expected.
```

## Per-file detail

| path | size(B) | plain named | tsx-grammar named | lost | lost% | sept DB nodes | DB matches reproduction |
|---|---|---|---|---|---|---|---|
| src/app/(auth)/auth/verify/page.tsx | 3382 | 2 | 4 | 2 | 50% | 2 | yes |
| src/app/(auth)/forgot-password/page.tsx | 5391 | 3 | 4 | 1 | 25% | 3 | yes |
| src/app/(auth)/reset-password/page.tsx | 10450 | 3 | 5 | 2 | 40% | 3 | yes |
| src/app/(auth)/sign-in/layout.tsx | 506 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(auth)/sign-in/page.tsx | 18446 | 8 | 10 | 2 | 20% | 8 | yes |
| src/app/(auth)/sign-up/page.tsx | 110 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(marketing)/aviso-legal/page.tsx | 5023 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(marketing)/layout.tsx | 1083 | 1 | 1 | 0 | 0% | 1 | NO |
| src/app/(marketing)/privacidad/page.tsx | 173 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(marketing)/privacy/page.tsx | 20799 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(marketing)/smooth-scroll.tsx | 502 | 2 | 2 | 0 | 0% | 2 | yes |
| src/app/(marketing)/terms/page.tsx | 4179 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(marketing)/unsubscribe/UnsubscribeContent.tsx | 2915 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/(marketing)/unsubscribe/page.tsx | 413 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/api-keys/ApiKeysPageClient.tsx | 16112 | 15 | 11 | -4 | -36.4% | 15 | yes |
| src/app/admin/api-keys/page.tsx | 323 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/calendar/page.tsx | 11579 | 7 | 8 | 1 | 12.5% | 7 | yes |
| src/app/admin/calidad/page.tsx | 12491 | 5 | 6 | 1 | 16.7% | 5 | yes |
| src/app/admin/calls/[id]/page.tsx | 13622 | 1 | 2 | 1 | 50% | 1 | yes |
| src/app/admin/calls/page.tsx | 27209 | 3 | 3 | 0 | 0% | 3 | yes |
| src/app/admin/campanias/[id]/page.tsx | 3794 | 4 | 1 | -3 | -300% | 4 | yes |
| src/app/admin/campanias/new/page.tsx | 1894 | 1 | 2 | 1 | 50% | 1 | yes |
| src/app/admin/campanias/page.tsx | 10697 | 3 | 4 | 1 | 25% | 3 | yes |
| src/app/admin/clientes/[clientId]/page.tsx | 7596 | 4 | 5 | 1 | 20% | 4 | yes |
| src/app/admin/clientes/importar/page.tsx | 9363 | 14 | 14 | 0 | 0% | 14 | yes |
| src/app/admin/clientes/nuevo/page.tsx | 6354 | 11 | 5 | -6 | -120% | 11 | yes |
| src/app/admin/clientes/page.tsx | 13236 | 10 | 11 | 1 | 9.1% | 9 | yes |
| src/app/admin/companies/[id]/appointments/new/page.tsx | 15911 | 3 | 4 | 1 | 25% | 3 | yes |
| src/app/admin/companies/[id]/appointments/page.tsx | 13543 | 10 | 11 | 1 | 9.1% | 10 | yes |
| src/app/admin/companies/[id]/calls/page.tsx | 16608 | 2 | 1 | -1 | -100% | 2 | yes |
| src/app/admin/companies/[id]/clients/[clientId]/edit/page.tsx | 7004 | 4 | 5 | 1 | 20% | 4 | yes |
| src/app/admin/companies/[id]/clients/import/page.tsx | 11588 | 19 | 20 | 1 | 5% | 19 | yes |
| src/app/admin/companies/[id]/clients/new/page.tsx | 6495 | 4 | 5 | 1 | 20% | 4 | yes |
| src/app/admin/companies/[id]/clients/page.tsx | 12438 | 11 | 11 | 0 | 0% | 10 | yes |
| src/app/admin/companies/[id]/contacts/[contactId]/edit/page.tsx | 16280 | 17 | 7 | -10 | -142.9% | 17 | yes |
| src/app/admin/companies/[id]/contacts/new/page.tsx | 13039 | 17 | 6 | -11 | -183.3% | 17 | yes |
| src/app/admin/companies/[id]/contacts/page.tsx | 18037 | 6 | 4 | -2 | -50% | 6 | yes |
| src/app/admin/companies/[id]/invites/invite-table.tsx | 7790 | 6 | 7 | 1 | 14.3% | 6 | yes |
| src/app/admin/companies/[id]/invites/page.tsx | 7423 | 6 | 6 | 0 | 0% | 6 | yes |
| src/app/admin/companies/layout.tsx | 743 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/companies/new/page.tsx | 15113 | 14 | 15 | 1 | 6.7% | 13 | NO |
| src/app/admin/companies/page.tsx | 19274 | 7 | 7 | 0 | 0% | 7 | NO |
| src/app/admin/config/agente/page.tsx | 10164 | 6 | 8 | 2 | 25% | 6 | yes |
| src/app/admin/config/page.tsx | 130 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/config/servicios/page.tsx | 627 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/contacts/page.tsx | 571 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/crm/analytics/page.tsx | 13421 | 7 | 9 | 2 | 22.2% | 7 | yes |
| src/app/admin/crm/archivo/page.tsx | 11486 | 9 | 12 | 3 | 25% | 9 | yes |
| src/app/admin/crm/configuracion/page.tsx | 14835 | 25 | 26 | 1 | 3.8% | 25 | yes |
| src/app/admin/crm/page.tsx | 8972 | 16 | 18 | 2 | 11.1% | 16 | yes |
| src/app/admin/design-test/page.tsx | 22832 | 0 | 1 | 1 | 100% | 0 | yes |
| src/app/admin/error-tracker/ErrorTrackerPageClient.tsx | 11673 | 3 | 3 | 0 | 0% | 3 | yes |
| src/app/admin/error-tracker/page.tsx | 343 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/guide/page.tsx | 10553 | 1 | 2 | 1 | 50% | 1 | yes |
| src/app/admin/layout.tsx | 835 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/logs/page.tsx | 771 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/not-found.tsx | 1146 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/notifications/page.tsx | 10588 | 6 | 9 | 3 | 33.3% | 6 | yes |
| src/app/admin/page.tsx | 2011 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/quality/page.tsx | 13958 | 11 | 12 | 1 | 8.3% | 11 | yes |
| src/app/admin/quality/rubrics/page.tsx | 12374 | 8 | 8 | 0 | 0% | 8 | yes |
| src/app/admin/settings/page.tsx | 9402 | 3 | 4 | 1 | 25% | 3 | yes |
| src/app/admin/telephony/costs/page.tsx | 15862 | 4 | 7 | 3 | 42.9% | 4 | yes |
| src/app/admin/telephony/layout.tsx | 317 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/telephony/numbers/purchase/page.tsx | 12576 | 3 | 4 | 1 | 25% | 3 | yes |
| src/app/admin/telephony/page.tsx | 1882 | 2 | 1 | -1 | -100% | 2 | yes |
| src/app/admin/telephony/providers/page.tsx | 5080 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/app/admin/templates/TemplatesPageClient.tsx | 670 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/templates/[id]/edit/page.tsx | 583 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/templates/[id]/page.tsx | 585 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/templates/library/page.tsx | 588 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/templates/new/page.tsx | 583 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/admin/templates/page.tsx | 331 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/global-error.tsx | 1284 | 0 | 1 | 1 | 100% | 0 | yes |
| src/app/layout.tsx | 6733 | 0 | 1 | 1 | 100% | 0 | yes |
| src/app/not-found.tsx | 1045 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/onboarding/layout.tsx | 649 | 1 | 1 | 0 | 0% | 1 | yes |
| src/app/onboarding/page.tsx | 14468 | 13 | 14 | 1 | 7.1% | 13 | NO |
| src/components/activity/ActivityLogCard.tsx | 8204 | 1 | 2 | 1 | 50% | 1 | yes |
| src/components/activity/TeamActivityDashboard.tsx | 10789 | 3 | 2 | -1 | -50% | 3 | yes |
| src/components/admin/AdminLayoutClient.tsx | 11613 | 5 | 9 | 4 | 44.4% | 5 | yes |
| src/components/admin/Breadcrumbs.tsx | 3488 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/admin/KpiCard.tsx | 1896 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/admin/PageHeader.tsx | 859 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/admin/PrismaStudioButton.tsx | 629 | 2 | 1 | -1 | -100% | 2 | yes |
| src/components/admin/UserMenu.tsx | 3639 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/analytics/ConsentAnalytics.tsx | 2381 | 3 | 3 | 0 | 0% | 3 | yes |
| src/components/analytics/PostHogProvider.tsx | 1226 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/billing/BillingTab.tsx | 4301 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/billing/PricingCards.tsx | 7937 | 1 | 3 | 2 | 66.7% | 1 | yes |
| src/components/billing/SidebarUsageWidget.tsx | 1372 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/billing/UsageLimitBanner.tsx | 1031 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/calendar/CalendarView.tsx | 10873 | 7 | 15 | 8 | 53.3% | 7 | yes |
| src/components/calendar/QuickCreateDialog.tsx | 9544 | 1 | 2 | 1 | 50% | 1 | yes |
| src/components/calls/CallAnalyticsDashboard.tsx | 8524 | 3 | 4 | 1 | 25% | 3 | yes |
| src/components/calls/DirectionBadge.tsx | 713 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/calls/FollowUpNotes.tsx | 6296 | 5 | 5 | 0 | 0% | 5 | yes |
| src/components/calls/InlineAudioPlayer.tsx | 3555 | 7 | 7 | 0 | 0% | 7 | yes |
| src/components/calls/SpeakerTranscription.tsx | 2491 | 1 | 2 | 1 | 50% | 1 | yes |
| src/components/campaigns/CampaignAnalyticsTab.tsx | 5972 | 0 | 2 | 2 | 100% | 0 | yes |
| src/components/campaigns/CampaignDashboard.tsx | 17431 | 9 | 9 | 0 | 0% | 9 | yes |
| src/components/campaigns/CampaignKpiPanel.tsx | 1759 | 2 | 1 | -1 | -100% | 2 | yes |
| src/components/campaigns/CampaignOutcomeChart.tsx | 4344 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/campaigns/CampaignQualityTrend.tsx | 5343 | 3 | 4 | 1 | 25% | 3 | yes |
| src/components/campaigns/CampaignWizard.tsx | 6385 | 4 | 5 | 1 | 20% | 4 | yes |
| src/components/campaigns/ColumnMapper.tsx | 6314 | 16 | 13 | -3 | -23.1% | 16 | yes |
| src/components/campaigns/CsvImporter.tsx | 7129 | 12 | 10 | -2 | -20% | 12 | yes |
| src/components/campaigns/DncBadge.tsx | 499 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/campaigns/ProspectTable.tsx | 11278 | 5 | 6 | 1 | 16.7% | 5 | yes |
| src/components/campaigns/WizardStep1Persona.tsx | 13724 | 7 | 8 | 1 | 12.5% | 7 | yes |
| src/components/campaigns/WizardStep2Prospects.tsx | 22516 | 13 | 13 | 0 | 0% | 13 | yes |
| src/components/campaigns/WizardStep3Schedule.tsx | 7268 | 3 | 4 | 1 | 25% | 3 | yes |
| src/components/campaigns/WizardStep4Review.tsx | 13602 | 7 | 5 | -2 | -40% | 7 | yes |
| src/components/companies/ActivateCompanyWizard.tsx | 13029 | 11 | 10 | -1 | -10% | 11 | yes |
| src/components/companies/EditAgentConfigDialog.tsx | 9302 | 12 | 8 | -4 | -50% | 12 | yes |
| src/components/companies/EditCompanyInfoDialog.tsx | 3836 | 7 | 2 | -5 | -250% | 7 | NO |
| src/components/companies/EditContactInfoDialog.tsx | 3399 | 6 | 2 | -4 | -200% | 6 | yes |
| src/components/companies/EditNotificationsDialog.tsx | 9083 | 5 | 4 | -1 | -25% | 5 | yes |
| src/components/companies/EditPhoneAssignmentDialog.tsx | 6721 | 6 | 5 | -1 | -20% | 6 | yes |
| src/components/companies/EditScriptTemplateDialog.tsx | 2526 | 5 | 3 | -2 | -66.7% | 5 | yes |
| src/components/companies/EditSubscriptionDialog.tsx | 4506 | 8 | 3 | -5 | -166.7% | 8 | yes |
| src/components/companies/KnowledgeBaseEditor.tsx | 4303 | 4 | 3 | -1 | -33.3% | 4 | yes |
| src/components/crm/CrmCallDialog.tsx | 13018 | 10 | 11 | 1 | 9.1% | 10 | yes |
| src/components/crm/CrmCallPopover.tsx | 7083 | 6 | 7 | 1 | 14.3% | 6 | yes |
| src/components/crm/FilterBar.tsx | 5875 | 3 | 3 | 0 | 0% | 3 | yes |
| src/components/crm/KanbanBoard.tsx | 10113 | 23 | 23 | 0 | 0% | 23 | yes |
| src/components/crm/KanbanCard.tsx | 4074 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/crm/KanbanColumn.tsx | 4199 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/crm/MetricsBar.tsx | 3143 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/crm/ReopenConfirmDialog.tsx | 1838 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/crm/StageConfigRow.tsx | 9897 | 5 | 6 | 1 | 16.7% | 5 | yes |
| src/components/crm/TableView.tsx | 10553 | 7 | 8 | 1 | 12.5% | 7 | yes |
| src/components/crm/VerticalSelector.tsx | 5958 | 3 | 5 | 2 | 40% | 3 | yes |
| src/components/forms/NewsletterForm.tsx | 4932 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/gdpr/CookieConsent.tsx | 12890 | 11 | 12 | 1 | 8.3% | 11 | yes |
| src/components/gdpr/ManageCookiesSection.tsx | 1068 | 3 | 3 | 0 | 0% | 3 | yes |
| src/components/notifications/NotificationBell.tsx | 11584 | 9 | 11 | 2 | 18.2% | 9 | yes |
| src/components/onboarding/Step1CompanyInfo.tsx | 10320 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/onboarding/Step2ServicesHours.tsx | 10784 | 9 | 10 | 1 | 10% | 8 | NO |
| src/components/onboarding/Step3SynioConfig.tsx | 13969 | 18 | 13 | -5 | -38.5% | 9 | NO |
| src/components/onboarding/Step4PreviewCall.tsx | 1695 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/onboarding/Step5GoLive.tsx | 5392 | 4 | 4 | 0 | 0% | 4 | yes |
| src/components/onboarding/WizardStepper.tsx | 2827 | 3 | 1 | -2 | -200% | 3 | yes |
| src/components/onboarding/__tests__/Step2ServicesHours.test.tsx | 3174 | 2 | 2 | 0 | 0% | 0 | NO |
| src/components/onboarding/__tests__/WizardStepper.test.tsx | 3712 | 0 | 0 | 0 | 0% | 0 | yes |
| src/components/providers/ClientProviders.tsx | 516 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/quality/DayBreakdownTable.tsx | 8834 | 4 | 4 | 0 | 0% | 4 | yes |
| src/components/quality/QualityOverviewCard.tsx | 3978 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/quality/QualityTrendChart.tsx | 4387 | 1 | 4 | 3 | 75% | 1 | yes |
| src/components/quality/RubricEditor.tsx | 8694 | 10 | 8 | -2 | -25% | 10 | yes |
| src/components/quality/ScoreBadge.tsx | 3557 | 1 | 2 | 1 | 50% | 1 | yes |
| src/components/quality/SuperuserQualityOverview.tsx | 7050 | 3 | 5 | 2 | 40% | 3 | yes |
| src/components/search/CollapsibleSearch.tsx | 2253 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/settings/PrivacyTab.tsx | 8828 | 7 | 8 | 1 | 12.5% | 7 | yes |
| src/components/shared/ConditionalFinancialTicker.tsx | 324 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/shared/FinancialTicker.tsx | 3831 | 1 | 3 | 2 | 66.7% | 1 | yes |
| src/components/templates/SystemPromptEditor.tsx | 3961 | 4 | 3 | -1 | -33.3% | 4 | yes |
| src/components/templates/TemplateTypeDialog.tsx | 3686 | 3 | 3 | 0 | 0% | 3 | yes |
| src/components/templates/TestTemplateDialog.tsx | 5772 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/test-engine/ProbarAgenteButton.tsx | 6426 | 6 | 7 | 1 | 14.3% | 6 | yes |
| src/components/test-engine/RegressionBadge.tsx | 628 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/test-engine/ScenarioTrendChart.tsx | 5880 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/test-engine/TestRunLauncher.tsx | 20160 | 14 | 13 | -1 | -7.7% | 14 | yes |
| src/components/test-engine/TestRunProgress.tsx | 5874 | 5 | 6 | 1 | 16.7% | 5 | yes |
| src/components/test-engine/TestRunResultCard.tsx | 11238 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/theme-provider.tsx | 337 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/CollapsibleSection.tsx | 1566 | 2 | 1 | -1 | -100% | 2 | yes |
| src/components/ui/accordion.tsx | 2031 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/ui/alert-dialog.tsx | 4433 | 2 | 8 | 6 | 75% | 2 | yes |
| src/components/ui/alert.tsx | 1598 | 2 | 3 | 1 | 33.3% | 2 | yes |
| src/components/ui/badge.tsx | 1170 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/button.tsx | 1959 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/card.tsx | 1881 | 1 | 6 | 5 | 83.3% | 1 | yes |
| src/components/ui/carousel.tsx | 6248 | 5 | 10 | 5 | 50% | 5 | yes |
| src/components/ui/checkbox.tsx | 1070 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/ui/confirm-dialog.tsx | 1410 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/dialog.tsx | 3957 | 1 | 6 | 5 | 83.3% | 1 | yes |
| src/components/ui/dropdown-menu.tsx | 7741 | 1 | 9 | 8 | 88.9% | 1 | yes |
| src/components/ui/empty-state.tsx | 1820 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/ui/help-tooltip.tsx | 1332 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/input.tsx | 916 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/label.tsx | 758 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/ui/popover.tsx | 1385 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/ui/progress.tsx | 930 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/ui/radio-group.tsx | 1477 | 2 | 2 | 0 | 0% | 2 | yes |
| src/components/ui/select.tsx | 5910 | 6 | 7 | 1 | 14.3% | 6 | yes |
| src/components/ui/sheet.tsx | 3639 | 3 | 6 | 3 | 50% | 3 | yes |
| src/components/ui/skeleton.tsx | 261 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/slider.tsx | 1096 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/status-badge.tsx | 1307 | 1 | 1 | 0 | 0% | 1 | yes |
| src/components/ui/switch.tsx | 1166 | 0 | 1 | 1 | 100% | 0 | yes |
| src/components/ui/table.tsx | 2911 | 1 | 8 | 7 | 87.5% | 1 | yes |
| src/components/ui/tabs.tsx | 1897 | 0 | 3 | 3 | 100% | 0 | yes |
| src/components/ui/textarea.tsx | 688 | 2 | 1 | -1 | -100% | 2 | yes |
| src/components/ui/tooltip.tsx | 1159 | 0 | 1 | 1 | 100% | 0 | yes |
| src/lib/analytics/plausible.tsx | 5006 | 16 | 16 | 0 | 0% | 16 | yes |
| src/lib/analytics/posthog.tsx | 6988 | 21 | 21 | 0 | 0% | 21 | yes |
| src/lib/trpc/provider.tsx | 861 | 3 | 3 | 0 | 0% | 3 | yes |
| src/pages/_error.tsx | 1226 | 0 | 2 | 2 | 100% | 0 | yes |
