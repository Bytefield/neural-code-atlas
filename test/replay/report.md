# nca_ask replay report — Phase A exit gate

Dist under test: `/mnt/c/dev/nca-replay-fixture/dist`
Queries replayed: 64

## Counts by class

| class | count |
|---|---|
| direct_hit | 7 |
| clean_no_match | 56 |
| noisy_fallback | 0 |
| known_env_error | 1 |
| product_error | 0 |

## Gate

| criterion | required | value | result |
|---|---|---|---|
| noisy_fallback_zero | == 0 | 0 | PASS |
| product_error_zero | == 0 (known_env_error excluded) | 0 | PASS |
| direct_hit_at_least_12 | >= 12 | 7 | FAIL |
| clean_no_match_explicit | every non-hit, non-error query is clean_no_match (0 noisy_fallback) | 56 | PASS |

**Overall gate: FAIL**

## Golden diffs

None — all direct_hit queries with a golden file match byte-for-byte after normalization.

## Out-of-scope project_arg queries (see manifest.queries.caveat_out_of_scope_project_args)

| event_id | query | project_arg | class |
|---|---|---|---|
| 049a63d2c1139d36 | "marketing page components" | /mnt/c/dev/webs/synio-web | known_env_error |
| 71316f96bcf178b8 | "PLAN-MAESTRO-UNIFICADO AUDITORIA-UI" | /mnt/c/Users/jesus/Desktop/Papi_Obsidian_Vault/02-Projects/synio | clean_no_match |
| 8ddc7a5e4fbb0419 | "CONTRATO-UI DESIGN-SYSTEM" | /mnt/c/Users/jesus/Desktop/Papi_Obsidian_Vault/02-Projects/synio | clean_no_match |
| c0f5b1ecd6132020 | "admin UI cambios rediseño dashboard" | /mnt/c/Users/jesus/Desktop/Papi_Obsidian_Vault/02-Projects/synio | clean_no_match |
| cd2d934834b38bd9 | "GUIDELINE landing-umbrella" | /mnt/c/Users/jesus/Desktop/Papi_Obsidian_Vault/02-Projects/synio | clean_no_match |
| d64512508a613737 | "marketing landing page cambios pendientes" | /mnt/c/Users/jesus/Desktop/Papi_Obsidian_Vault/02-Projects/synio | clean_no_match |

## All queries

| event_id | class | query |
|---|---|---|
| 02bec69b581249ca | clean_no_match | "getCompanies showArchived filter archived companies list" |
| 040d683498e3f5ef | clean_no_match | "RLS row level security tenant isolation middleware prisma" |
| 049a63d2c1139d36 | known_env_error | "marketing page components" |
| 0e6d4f2686cc7ee4 | clean_no_match | "ActivateCompanyWizard WizardStep" |
| 14a67463491e142e | direct_hit | "shouldApplyRLS" |
| 197691b9e095a925 | direct_hit | "archiveCompany" |
| 1b1d03ff9287827e | clean_no_match | "SENTRY_AUTH_TOKEN" |
| 210e9e2349d5d4f3 | clean_no_match | "DISCORD_NOTIFICATION_WEBHOOK" |
| 2b9b331ed61e8fce | clean_no_match | "company-assistant retell agent prompt push update" |
| 2fa8c2c4430f5efe | clean_no_match | "admin superuser role permission" |
| 313f77cf78f369d4 | clean_no_match | "entitlements subscription status" |
| 32b1871be396d7ff | clean_no_match | "manage-appointment.ts imports dependencies" |
| 4347cae108cc3fa6 | clean_no_match | "public API integration endpoint external" |
| 4394b0df6c0b9b5f | clean_no_match | "CompanyConfig loadCompanyConfigForPrompt" |
| 4551b054011ce9fc | clean_no_match | "CompanyConfigForm EditVoiceConfig" |
| 4989090c149d0489 | clean_no_match | "marketing page landing page design" |
| 4ad09ac3d96c74b8 | clean_no_match | "applyTemplate verticalTemplate" |
| 4e927cb09554e948 | clean_no_match | "companyProcedure" |
| 4edb26fd8e16329a | clean_no_match | "GOOGLE_CALENDAR_CLIENT_ID" |
| 53ecd51c6d9bcca0 | clean_no_match | "voiceRules" |
| 58bfe33a38d8f8fa | clean_no_match | "CANCELLED PAST_DUE subscription" |
| 59655a4daa54901e | clean_no_match | "checkAvailability slot locking" |
| 65c5338cc438e195 | clean_no_match | "AZURE_CALENDAR_CLIENT_ID" |
| 67274fea04730e94 | clean_no_match | "ioredis client connection" |
| 6b4156696acef1f7 | clean_no_match | "webhook handler retell flash telecom vapi signature verification" |
| 6cb66c55da1a16af | clean_no_match | "vapi tools manage-appointment build-prompt token-estimator" |
| 71316f96bcf178b8 | clean_no_match | "PLAN-MAESTRO-UNIFICADO AUDITORIA-UI" |
| 77fb9296660c0382 | clean_no_match | "DISCORD_ERROR_WEBHOOK" |
| 7e64f2f2f5efd605 | clean_no_match | "admin UI dashboard changes redesign" |
| 825bb4cea88370ab | clean_no_match | "ecosystem config pm2 staging" |
| 83096b383d93dd6f | direct_hit | "buildIdentity" |
| 8ddc7a5e4fbb0419 | clean_no_match | "CONTRATO-UI DESIGN-SYSTEM" |
| 8df1ea0b273f7ae9 | direct_hit | "EditAgentConfig" |
| 974eebee86ba263f | clean_no_match | "plan limits enforcement agent number" |
| 97567728eef0ce40 | clean_no_match | "onboarding setup wizard" |
| a1a7d0eb0589f758 | clean_no_match | "$queryRaw raw SQL injection unsafe query" |
| a27fca3cecad2b12 | clean_no_match | "voiceRules" |
| a66eeca3b64f454b | clean_no_match | "AdminDashboardPage AdminLayout components" |
| abbddeebb9010aaa | clean_no_match | "AdminDashboardPage AdminLayout" |
| aeb3bf5484f84ce2 | clean_no_match | "files inside src/lib/vapi that import from outside vapi directory" |
| af01ab0d7d9db27b | clean_no_match | "syncAgent updateRetellAgent" |
| bb8b4883f5f9370c | clean_no_match | "RETELL_WEBHOOK_SECRET" |
| c0f5b1ecd6132020 | clean_no_match | "admin UI cambios rediseño dashboard" |
| c7e6f783e1a51c8a | clean_no_match | "createCompany CreateCompanyForm" |
| c871e30d25e2c90b | clean_no_match | "overall system architecture entry points routers tRPC auth middleware tenancy" |
| c9b5a8d8329b3e3a | clean_no_match | "webhook routes API endpoints retell" |
| ca87e4124cdec550 | clean_no_match | "archiveCompany mutation 400 bad request already archived" |
| ccf25e844034d5a9 | direct_hit | "buildIdentity" |
| cd2d934834b38bd9 | clean_no_match | "GUIDELINE landing-umbrella" |
| d06f5159254435df | clean_no_match | "SENTRY_ORG" |
| d64512508a613737 | clean_no_match | "marketing landing page cambios pendientes" |
| d6886dd681fb9808 | clean_no_match | "isNoShowRecovery" |
| d71a781a02a5997e | clean_no_match | "authentication authorization middleware session" |
| e0ddfc66d37dd1b0 | clean_no_match | "appointment concurrency transaction" |
| e0fcc5cc3939ac1c | clean_no_match | "SENTRY_PROJECT" |
| e344329d8432f075 | clean_no_match | "companyProcedure staffProcedure definition middleware" |
| e7b174a282aeff21 | clean_no_match | "agent locale country language config" |
| e98570b337329a37 | direct_hit | "validateCompanyAccess" |
| eae7f5317a98311b | direct_hit | "getCompanies" |
| ec16fddb3b924ab5 | clean_no_match | "files that import from src/lib/vapi" |
| ef61595435a314bf | clean_no_match | "manageAppointment booking" |
| f1166c163cf9bff8 | clean_no_match | "withRLSContext" |
| f211e9640deed031 | clean_no_match | "companyProcedure protectedProcedure publicProcedure tRPC procedure builders" |
| fad8dca3d0b5244f | clean_no_match | "RLS row level security tenant isolation companyId" |
