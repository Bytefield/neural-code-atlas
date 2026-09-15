# nca_ask replay — drift report (Replay B, informational, no gate)

Dist: `/mnt/c/dev/nca-recall-diagnosis/dist` — CURRENT (September) index. See report.md for the gated Phase A report; criterion 3 there is decided by Replay A (replay-a-report.json / replay-a.js), not by this file.

## Historical baseline (June 2026 live sessions), same classifier

All 64: {"noisy_fallback":47,"direct_hit":8,"known_env_error":4,"clean_no_match":5}

In-scope 58: {"noisy_fallback":46,"direct_hit":8,"known_env_error":4}

Historical in-scope direct_hit count: 8. See replay-a-report.json for how many of these reproduce against a period-correct (June) index/build pair — this section only traces them against the CURRENT (drifted) index.

### Traceability: historical in-scope direct_hit -> today's replay class (current index)

| event_id | query | replay class today | drift verdict |
|---|---|---|---|
| 14a67463491e142e | "shouldApplyRLS" | direct_hit | n/a |
| 197691b9e095a925 | "archiveCompany" | direct_hit | n/a |
| 83096b383d93dd6f | "buildIdentity" | direct_hit | n/a |
| 8df1ea0b273f7ae9 | "EditAgentConfig" | direct_hit | n/a |
| ccf25e844034d5a9 | "buildIdentity" | direct_hit | n/a |
| e98570b337329a37 | "validateCompanyAccess" | direct_hit | n/a |
| eae7f5317a98311b | "getCompanies" | direct_hit | n/a |
| f1166c163cf9bff8 | "withRLSContext" | clean_no_match | source_text_present_but_not_retrieved |

## Drift analysis (clean_no_match, in-scope only)

Counts — symbol_absent (drift): 10 · source_text_present_but_not_retrieved: 26 · undeterminable: 15

`source_text_present_but_not_retrieved` means: the candidate token(s) extracted from the query still appear as TEXT in the synio tree at the commit this (current) index was built from, but nca_ask returned no match. It does NOT by itself mean NCA regressed — see replay-a-report.json for the empirical, build-isolated answer on whichever of these were also historical hits.

| event_id | query | candidate(s) | exists in synio@commit | verdict |
|---|---|---|---|---|
| 02bec69b581249ca | "getCompanies showArchived filter archived companies list" | getCompanies ✓, showArchived ✓ | yes | source_text_present_but_not_retrieved |
| 040d683498e3f5ef | "RLS row level security tenant isolation middleware prisma" | — | no | undeterminable |
| 0e6d4f2686cc7ee4 | "ActivateCompanyWizard WizardStep" | ActivateCompanyWizard ✓, WizardStep ✓ | yes | source_text_present_but_not_retrieved |
| 1b1d03ff9287827e | "SENTRY_AUTH_TOKEN" | SENTRY_AUTH_TOKEN ✗ | no | symbol_absent |
| 210e9e2349d5d4f3 | "DISCORD_NOTIFICATION_WEBHOOK" | DISCORD_NOTIFICATION_WEBHOOK ✓ | yes | source_text_present_but_not_retrieved |
| 2b9b331ed61e8fce | "company-assistant retell agent prompt push update" | company-assistant ✓ | yes | source_text_present_but_not_retrieved |
| 2fa8c2c4430f5efe | "admin superuser role permission" | — | no | undeterminable |
| 313f77cf78f369d4 | "entitlements subscription status" | — | no | undeterminable |
| 32b1871be396d7ff | "manage-appointment.ts imports dependencies" | manage-appointment.ts ✗ | no | symbol_absent |
| 4347cae108cc3fa6 | "public API integration endpoint external" | — | no | undeterminable |
| 4394b0df6c0b9b5f | "CompanyConfig loadCompanyConfigForPrompt" | CompanyConfig ✓, loadCompanyConfigForPrompt ✓ | yes | source_text_present_but_not_retrieved |
| 4551b054011ce9fc | "CompanyConfigForm EditVoiceConfig" | CompanyConfigForm ✗, EditVoiceConfig ✗ | no | symbol_absent |
| 4989090c149d0489 | "marketing page landing page design" | — | no | undeterminable |
| 4ad09ac3d96c74b8 | "applyTemplate verticalTemplate" | applyTemplate ✓, verticalTemplate ✗ | yes | source_text_present_but_not_retrieved |
| 4e927cb09554e948 | "companyProcedure" | companyProcedure ✓ | yes | source_text_present_but_not_retrieved |
| 4edb26fd8e16329a | "GOOGLE_CALENDAR_CLIENT_ID" | GOOGLE_CALENDAR_CLIENT_ID ✓ | yes | source_text_present_but_not_retrieved |
| 53ecd51c6d9bcca0 | "voiceRules" | voiceRules ✗ | no | symbol_absent |
| 58bfe33a38d8f8fa | "CANCELLED PAST_DUE subscription" | PAST_DUE ✓ | yes | source_text_present_but_not_retrieved |
| 59655a4daa54901e | "checkAvailability slot locking" | checkAvailability ✓ | yes | source_text_present_but_not_retrieved |
| 65c5338cc438e195 | "AZURE_CALENDAR_CLIENT_ID" | AZURE_CALENDAR_CLIENT_ID ✓ | yes | source_text_present_but_not_retrieved |
| 67274fea04730e94 | "ioredis client connection" | — | no | undeterminable |
| 6b4156696acef1f7 | "webhook handler retell flash telecom vapi signature verification" | — | no | undeterminable |
| 6cb66c55da1a16af | "vapi tools manage-appointment build-prompt token-estimator" | manage-appointment ✗, build-prompt ✓, token-estimator ✓ | yes | source_text_present_but_not_retrieved |
| 77fb9296660c0382 | "DISCORD_ERROR_WEBHOOK" | DISCORD_ERROR_WEBHOOK ✓ | yes | source_text_present_but_not_retrieved |
| 7e64f2f2f5efd605 | "admin UI dashboard changes redesign" | — | no | undeterminable |
| 825bb4cea88370ab | "ecosystem config pm2 staging" | — | no | undeterminable |
| 974eebee86ba263f | "plan limits enforcement agent number" | — | no | undeterminable |
| 97567728eef0ce40 | "onboarding setup wizard" | — | no | undeterminable |
| a1a7d0eb0589f758 | "$queryRaw raw SQL injection unsafe query" | $queryRaw ✓ | yes | source_text_present_but_not_retrieved |
| a27fca3cecad2b12 | "voiceRules" | voiceRules ✗ | no | symbol_absent |
| a66eeca3b64f454b | "AdminDashboardPage AdminLayout components" | AdminDashboardPage ✓, AdminLayout ✓ | yes | source_text_present_but_not_retrieved |
| abbddeebb9010aaa | "AdminDashboardPage AdminLayout" | AdminDashboardPage ✓, AdminLayout ✓ | yes | source_text_present_but_not_retrieved |
| aeb3bf5484f84ce2 | "files inside src/lib/vapi that import from outside vapi directory" | src/lib/vapi ✗ | no | symbol_absent |
| af01ab0d7d9db27b | "syncAgent updateRetellAgent" | syncAgent ✗, updateRetellAgent ✓ | yes | source_text_present_but_not_retrieved |
| bb8b4883f5f9370c | "RETELL_WEBHOOK_SECRET" | RETELL_WEBHOOK_SECRET ✗ | no | symbol_absent |
| c7e6f783e1a51c8a | "createCompany CreateCompanyForm" | createCompany ✓, CreateCompanyForm ✗ | yes | source_text_present_but_not_retrieved |
| c871e30d25e2c90b | "overall system architecture entry points routers tRPC auth middleware tenancy" | tRPC ✓ | yes | source_text_present_but_not_retrieved |
| c9b5a8d8329b3e3a | "webhook routes API endpoints retell" | — | no | undeterminable |
| ca87e4124cdec550 | "archiveCompany mutation 400 bad request already archived" | archiveCompany ✓ | yes | source_text_present_but_not_retrieved |
| d06f5159254435df | "SENTRY_ORG" | SENTRY_ORG ✗ | no | symbol_absent |
| d6886dd681fb9808 | "isNoShowRecovery" | isNoShowRecovery ✓ | yes | source_text_present_but_not_retrieved |
| d71a781a02a5997e | "authentication authorization middleware session" | — | no | undeterminable |
| e0ddfc66d37dd1b0 | "appointment concurrency transaction" | — | no | undeterminable |
| e0fcc5cc3939ac1c | "SENTRY_PROJECT" | SENTRY_PROJECT ✗ | no | symbol_absent |
| e344329d8432f075 | "companyProcedure staffProcedure definition middleware" | companyProcedure ✓, staffProcedure ✓ | yes | source_text_present_but_not_retrieved |
| e7b174a282aeff21 | "agent locale country language config" | — | no | undeterminable |
| ec16fddb3b924ab5 | "files that import from src/lib/vapi" | src/lib/vapi ✗ | no | symbol_absent |
| ef61595435a314bf | "manageAppointment booking" | manageAppointment ✓ | yes | source_text_present_but_not_retrieved |
| f1166c163cf9bff8 | "withRLSContext" | withRLSContext ✓ | yes | source_text_present_but_not_retrieved |
| f211e9640deed031 | "companyProcedure protectedProcedure publicProcedure tRPC procedure builders" | companyProcedure ✓, protectedProcedure ✓, publicProcedure ✓, tRPC ✓ | yes | source_text_present_but_not_retrieved |
| fad8dca3d0b5244f | "RLS row level security tenant isolation companyId" | companyId ✓ | yes | source_text_present_but_not_retrieved |
