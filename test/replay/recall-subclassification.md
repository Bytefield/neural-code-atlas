# nca_ask recall gap sub-classification — Phase B, second evidence pass

Source: `/mnt/c/dev/nca-recall-subsplit/test/replay/recall-diagnosis.json`

## Indexing contract (observed)

From `src/parser.ts` (read-only inspection):

- TypeScript/JavaScript function_node_types: `function_declaration, function_expression, arrow_function, method_definition`
- TypeScript/JavaScript class_node_types: `class_declaration`
- Python function_node_types: `function_definition`, class_node_types: `class_definition`
- Type mapping: getNodeKind(treeSitterType): includes('class')->'class', includes('method')->'method', includes('arrow')->'arrow', else->'function' (so function_declaration AND function_expression both map to node type 'function').
- Extraction walk: rootNode.descendantsOfType([...functionNodeTypes, ...classNodeTypes]) — ALL descendants at ANY nesting depth, not just top-level. A matched node is only kept if extractNodeName() resolves a name: for arrow_function/function_expression, walks UP the parent chain through wrapping nodes (e.g. call_expression/arguments, as in `const x = wrapper(() => {...})`) looking for a variable_declarator, assignment_expression, object pair, or method_definition to name it from; gives up (dropped, not indexed) at a statement_block/program/function_declaration boundary with no name found.
- NOT in contract: Interfaces, type aliases, enums, plain const/let/var declarations NOT assigned an arrow_function/function_expression literal (e.g. `const x = builder.use(y)`), object properties that are not method_definition, .sql files, .prisma schema files, .md files, comments, string literals (env var names, tool-name strings) — none of these produce a node, by design (out of functionNodeTypes/classNodeTypes scope, or the file extension isn't parsed by any LanguageExtractor at all).

From the September index (`SELECT type, COUNT(*) FROM nodes GROUP BY type`):

| type | count |
|---|---|
| arrow | 1451 |
| function | 1160 |
| method | 167 |
| class | 17 |

**No discrepancy**: every observed `type` value is accounted for by the source contract above.

## INDEXER_NOT_CAPTURED sub-classification (14 rows)

Per-row subclass = highest-priority verdict among its candidates, priority order: INDEXABLE_CONSTRUCT_NO_NODE > NON_INDEXABLE_BY_DESIGN > TEXT_ONLY_NOT_INDEXABLE > UNDETERMINED (most actionable first).

| subclass | count |
|---|---|
| INDEXABLE_CONSTRUCT_NO_NODE | 2 |
| NON_INDEXABLE_BY_DESIGN | 12 |

| event_id | query | subclass | driving candidate | evidence |
|---|---|---|---|---|
| 0e6d4f2686cc7ee4 | "ActivateCompanyWizard WizardStep" | INDEXABLE_CONSTRUCT_NO_NODE | ActivateCompanyWizard | declaration matches an indexed construct shape: src/components/companies/ActivateCompanyWizard.tsx:32: export function ActivateCompanyWizard({ |
| 210e9e2349d5d4f3 | "DISCORD_NOTIFICATION_WEBHOOK" | NON_INDEXABLE_BY_DESIGN | DISCORD_NOTIFICATION_WEBHOOK | real declaration but not an indexed construct type: src/lib/notifications/discord.ts:19: const webhookUrl = process.env.DISCORD_NOTIFICATION_WEBHOOK; |
| 4e927cb09554e948 | "companyProcedure" | NON_INDEXABLE_BY_DESIGN | companyProcedure | real declaration but not an indexed construct type: src/server/trpc/init.ts:426: export const companyProcedure = protectedProcedure |
| 4edb26fd8e16329a | "GOOGLE_CALENDAR_CLIENT_ID" | NON_INDEXABLE_BY_DESIGN | GOOGLE_CALENDAR_CLIENT_ID | real declaration but not an indexed construct type: src/app/api/calendar/google/authorize/route.ts:76: const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID; |
| 58bfe33a38d8f8fa | "CANCELLED PAST_DUE subscription" | NON_INDEXABLE_BY_DESIGN | PAST_DUE | object/property literal value assignment, not a declaration of any indexed construct type: src/components/billing/BillingTab.tsx:18: PAST_DUE: "Pago pendiente", |
| 65c5338cc438e195 | "AZURE_CALENDAR_CLIENT_ID" | NON_INDEXABLE_BY_DESIGN | AZURE_CALENDAR_CLIENT_ID | real declaration but not an indexed construct type: src/app/api/calendar/microsoft/authorize/route.ts:75: const clientId = process.env.AZURE_CALENDAR_CLIENT_ID; |
| 77fb9296660c0382 | "DISCORD_ERROR_WEBHOOK" | NON_INDEXABLE_BY_DESIGN | DISCORD_ERROR_WEBHOOK | real declaration but not an indexed construct type: src/lib/sentry/discord-webhook.ts:30: const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK; |
| c871e30d25e2c90b | "overall system architecture entry points routers tRPC auth middleware tenancy" | NON_INDEXABLE_BY_DESIGN | tRPC | only usage sites (property access, process.env reference, string literal), no declaration statement for this exact token |
| d6886dd681fb9808 | "isNoShowRecovery" | NON_INDEXABLE_BY_DESIGN | isNoShowRecovery | object/property literal value assignment, not a declaration of any indexed construct type: src/lib/crm/apply-template.ts:60: isNoShowRecovery: stage.isNoShowRecovery ?? false, |
| e344329d8432f075 | "companyProcedure staffProcedure definition middleware" | NON_INDEXABLE_BY_DESIGN | companyProcedure | real declaration but not an indexed construct type: src/server/trpc/init.ts:426: export const companyProcedure = protectedProcedure |
| ef61595435a314bf | "manageAppointment booking" | NON_INDEXABLE_BY_DESIGN | manageAppointment | object/property literal value assignment, not a declaration of any indexed construct type: src/components/companies/EditAgentConfigDialog.tsx:31: manageAppointment: { |
| f1166c163cf9bff8 | "withRLSContext" | INDEXABLE_CONSTRUCT_NO_NODE | withRLSContext | declaration matches an indexed construct shape: src/server/trpc/init.ts:363: const withRLSContext = t.middleware(async ({ ctx, next }) => { |
| f211e9640deed031 | "companyProcedure protectedProcedure publicProcedure tRPC procedure builders" | NON_INDEXABLE_BY_DESIGN | companyProcedure | real declaration but not an indexed construct type: src/server/trpc/init.ts:426: export const companyProcedure = protectedProcedure |
| fad8dca3d0b5244f | "RLS row level security tenant isolation companyId" | NON_INDEXABLE_BY_DESIGN | companyId | object/property literal value assignment, not a declaration of any indexed construct type: prisma/seed-demo.ts:81: companyId: demoCompany.id, |

### Per-candidate detail (all candidates checked per row, not just the driving one)

**0e6d4f2686cc7ee4** ("ActivateCompanyWizard WizardStep") -> INDEXABLE_CONSTRUCT_NO_NODE
- `ActivateCompanyWizard`: INDEXABLE_CONSTRUCT_NO_NODE — declaration matches an indexed construct shape: src/components/companies/ActivateCompanyWizard.tsx:32: export function ActivateCompanyWizard({
- `WizardStep`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/app/admin/companies/new/page.tsx:28: type WizardStep,

**210e9e2349d5d4f3** ("DISCORD_NOTIFICATION_WEBHOOK") -> NON_INDEXABLE_BY_DESIGN
- `DISCORD_NOTIFICATION_WEBHOOK`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/lib/notifications/discord.ts:19: const webhookUrl = process.env.DISCORD_NOTIFICATION_WEBHOOK;

**4e927cb09554e948** ("companyProcedure") -> NON_INDEXABLE_BY_DESIGN
- `companyProcedure`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/server/trpc/init.ts:426: export const companyProcedure = protectedProcedure

**4edb26fd8e16329a** ("GOOGLE_CALENDAR_CLIENT_ID") -> NON_INDEXABLE_BY_DESIGN
- `GOOGLE_CALENDAR_CLIENT_ID`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/app/api/calendar/google/authorize/route.ts:76: const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;

**58bfe33a38d8f8fa** ("CANCELLED PAST_DUE subscription") -> NON_INDEXABLE_BY_DESIGN
- `PAST_DUE`: NON_INDEXABLE_BY_DESIGN — object/property literal value assignment, not a declaration of any indexed construct type: src/components/billing/BillingTab.tsx:18: PAST_DUE: "Pago pendiente",

**65c5338cc438e195** ("AZURE_CALENDAR_CLIENT_ID") -> NON_INDEXABLE_BY_DESIGN
- `AZURE_CALENDAR_CLIENT_ID`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/app/api/calendar/microsoft/authorize/route.ts:75: const clientId = process.env.AZURE_CALENDAR_CLIENT_ID;

**77fb9296660c0382** ("DISCORD_ERROR_WEBHOOK") -> NON_INDEXABLE_BY_DESIGN
- `DISCORD_ERROR_WEBHOOK`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/lib/sentry/discord-webhook.ts:30: const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK;

**c871e30d25e2c90b** ("overall system architecture entry points routers tRPC auth middleware tenancy") -> NON_INDEXABLE_BY_DESIGN
- `tRPC`: NON_INDEXABLE_BY_DESIGN — only usage sites (property access, process.env reference, string literal), no declaration statement for this exact token

**d6886dd681fb9808** ("isNoShowRecovery") -> NON_INDEXABLE_BY_DESIGN
- `isNoShowRecovery`: NON_INDEXABLE_BY_DESIGN — object/property literal value assignment, not a declaration of any indexed construct type: src/lib/crm/apply-template.ts:60: isNoShowRecovery: stage.isNoShowRecovery ?? false,

**e344329d8432f075** ("companyProcedure staffProcedure definition middleware") -> NON_INDEXABLE_BY_DESIGN
- `companyProcedure`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/server/trpc/init.ts:426: export const companyProcedure = protectedProcedure
- `staffProcedure`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/server/trpc/init.ts:586: export const staffProcedure = t.procedure

**ef61595435a314bf** ("manageAppointment booking") -> NON_INDEXABLE_BY_DESIGN
- `manageAppointment`: NON_INDEXABLE_BY_DESIGN — object/property literal value assignment, not a declaration of any indexed construct type: src/components/companies/EditAgentConfigDialog.tsx:31: manageAppointment: {

**f1166c163cf9bff8** ("withRLSContext") -> INDEXABLE_CONSTRUCT_NO_NODE
- `withRLSContext`: INDEXABLE_CONSTRUCT_NO_NODE — declaration matches an indexed construct shape: src/server/trpc/init.ts:363: const withRLSContext = t.middleware(async ({ ctx, next }) => {

**f211e9640deed031** ("companyProcedure protectedProcedure publicProcedure tRPC procedure builders") -> NON_INDEXABLE_BY_DESIGN
- `companyProcedure`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/server/trpc/init.ts:426: export const companyProcedure = protectedProcedure
- `protectedProcedure`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/server/trpc/init.ts:161: export const protectedProcedure = t.procedure
- `publicProcedure`: NON_INDEXABLE_BY_DESIGN — real declaration but not an indexed construct type: src/server/trpc/init.ts:122: export const publicProcedure = t.procedure.use(errorTracking);
- `tRPC`: NON_INDEXABLE_BY_DESIGN — only usage sites (property access, process.env reference, string literal), no declaration statement for this exact token

**fad8dca3d0b5244f** ("RLS row level security tenant isolation companyId") -> NON_INDEXABLE_BY_DESIGN
- `companyId`: NON_INDEXABLE_BY_DESIGN — object/property literal value assignment, not a declaration of any indexed construct type: prisma/seed-demo.ts:81: companyId: demoCompany.id,

## NODE_PRESENT_MATCHER_MISSED sub-classification (12 rows)

Rules: EXACT_NODE_NAME_MISSED (query trim == node.name exactly) / EXACT_PATH_MISSED (query trim == node.file exactly or as basename) / MULTI_TOKEN_QUERY (query contains a matched node name as one of several tokens — not caller misuse, nca_ask's own description invites this) / OTHER (reported literally, not grouped).

| subclass | count |
|---|---|
| MULTI_TOKEN_QUERY | 10 |
| OTHER | 2 |

| event_id | query | subclass | pattern |
|---|---|---|---|
| 02bec69b581249ca | "getCompanies showArchived filter archived companies list" | MULTI_TOKEN_QUERY | query has 6 tokens, one of which ('getCompanies') exactly matches a node name |
| 2b9b331ed61e8fce | "company-assistant retell agent prompt push update" | OTHER | partial path match — query contains path-shaped token(s) (company-assistant) that substring-matched multiple nodes' file paths; none of those nodes' NAMES appear as an exact token in the query text ('company-assistant retell agent prompt push update') — matched node names: loadCompanyConfigForPrompt, services, buildBeginMessage, createRetellAssistant, updateRetellAssistant, deleteRetellAssistant, createRetellLlm, updateRetellLlm, deleteRetellLlm, createRetellAgent, updateRetellAgent, deleteRetellAgent, buildRetellTools |
| 4394b0df6c0b9b5f | "CompanyConfig loadCompanyConfigForPrompt" | MULTI_TOKEN_QUERY | query has 2 tokens, one of which ('loadCompanyConfigForPrompt') exactly matches a node name |
| 4ad09ac3d96c74b8 | "applyTemplate verticalTemplate" | MULTI_TOKEN_QUERY | query has 2 tokens, one of which ('applyTemplate') exactly matches a node name |
| 59655a4daa54901e | "checkAvailability slot locking" | MULTI_TOKEN_QUERY | query has 3 tokens, one of which ('checkAvailability') exactly matches a node name |
| 6cb66c55da1a16af | "vapi tools manage-appointment build-prompt token-estimator" | OTHER | partial path match — query contains path-shaped token(s) (manage-appointment, build-prompt, token-estimator) that substring-matched multiple nodes' file paths; none of those nodes' NAMES appear as an exact token in the query text ('vapi tools manage-appointment build-prompt token-estimator') — matched node names: buildPrompt, includedSections, prompt, createDentalConfig, sumOfSections, estimateTokens |
| a1a7d0eb0589f758 | "$queryRaw raw SQL injection unsafe query" | MULTI_TOKEN_QUERY | query has 6 tokens, one of which ('$queryRaw') exactly matches a node name |
| a66eeca3b64f454b | "AdminDashboardPage AdminLayout components" | MULTI_TOKEN_QUERY | query has 3 tokens, one of which ('AdminDashboardPage') exactly matches a node name |
| abbddeebb9010aaa | "AdminDashboardPage AdminLayout" | MULTI_TOKEN_QUERY | query has 2 tokens, one of which ('AdminDashboardPage') exactly matches a node name |
| af01ab0d7d9db27b | "syncAgent updateRetellAgent" | MULTI_TOKEN_QUERY | query has 2 tokens, one of which ('updateRetellAgent') exactly matches a node name |
| c7e6f783e1a51c8a | "createCompany CreateCompanyForm" | MULTI_TOKEN_QUERY | query has 2 tokens, one of which ('createCompany') exactly matches a node name |
| ca87e4124cdec550 | "archiveCompany mutation 400 bad request already archived" | MULTI_TOKEN_QUERY | query has 7 tokens, one of which ('archiveCompany') exactly matches a node name |

## EXACT_*_MISSED nca_ask reproduction (0 case(s))

None of the 12 NODE_PRESENT_MATCHER_MISSED queries are exact single-term name/path matches — every one is multi-token by construction (see table above). No EXACT_*_MISSED case exists to reproduce.

## Phase B implication, per sub-class (mechanical, no implementation recommended)

- INDEXABLE_CONSTRUCT_NO_NODE -> possible finding of indexer coverage.
- NON_INDEXABLE_BY_DESIGN / TEXT_ONLY_NOT_INDEXABLE -> correct behavior; not a finding.
- EXACT_NODE_NAME_MISSED -> strong symbol-matcher defect (none observed among these 12).
- EXACT_PATH_MISSED -> path-matcher defect (none observed among these 12).
- MULTI_TOKEN_QUERY -> mismatch between what nca_ask's description promises ("function name, concept, module, etc.") and what it retrieves; whether the fix is the description, the capability, or neither is not decided here.
- OTHER -> literal inspection only (none observed among these 12).

## Addendum (2026-09-16): the 4 previously-open cases — verdicts

Full evidence, commit+file+line+literal for every claim, in `test/replay/rootcause-2gaps.md` / `.json` (`test/replay/rootcause-2gaps.js`, read-only against git object `e29cb7a1` exclusively — never the synio working tree). Summary:

**ActivateCompanyWizard (INDEXABLE_CONSTRUCT_NO_NODE)** — CONFIRMED, root cause RESOLVED. `.tsx` files are parsed with the plain (non-JSX) TypeScript grammar: `src/parser.ts:239` maps the `tsx` extension to the same parser instance built from `tsLanguage = require('tree-sitter-typescript').typescript` (line 22), never `tree-sitter-typescript`'s separate `.tsx` grammar export. Re-parsing the exact e29cb7a1 git blob of `ActivateCompanyWizard.tsx` with that same (plain) grammar produces 125 ERROR nodes (`hasError=true`); only 11 function-type nodes survive anywhere in the whole file — all inner, non-JSX event-handler arrow functions defined before the component's JSX return. Those 11 reproduced nodes are **name+type+line identical** to the September index's actual 11 nodes for this file — strong, not merely plausible, confirmation this is the real mechanism. The outer `export function ActivateCompanyWizard({ ... })` (whose body directly contains the JSX) is not recognized as a clean node under this grammar. This mismatch is a property of the `.tsx` extension in general, not specific to this file — not investigated further here (out of scope), but flagged as evidence the blast radius is likely broader than one component.

**withRLSContext (INDEXABLE_CONSTRUCT_NO_NODE)** — CONFIRMED, root cause UNRESOLVED (scan/parser frontier). All 10 occurrences of `withRLSContext` at e29cb7a1 are listed in `rootcause-2gaps.md`; only `src/server/trpc/init.ts:363` (`const withRLSContext = t.middleware(async ({ ctx, next }) => {`) is a real declaration — an `arrow_function` AST node. Re-running `src/parser.ts`'s exact (unmodified, reproduced read-only) `extractNodeName()` logic against that exact node proves it resolves to `'withRLSContext'` via `arrow_function -> arguments -> call_expression -> variable_declarator` — it is NAMED, not discarded, under the CURRENT parser.ts logic. `init.ts` uses the correct (non-JSX-mismatched) grammar, and 9 other nodes from this same file exist in the September index. Why the September scan specifically missed this one construct, when it provably resolves under current logic, is not decided here — possible causes include an older parser.ts version at scan time, or an unrelated scan-time mechanic — reported as an open question, not concluded.

**Prior-report discrepancy resolved:** an earlier report claimed withRLSContext's "only surviving occurrence is inside a comment." That claim was **incorrect** — traced to `drift.js`'s `gitGrepExists()` storing only the FIRST of 10 `git grep e29cb7a1` matches as "evidence" (git grep orders by file path; `context.ts` < `init.ts` alphabetically, so the stored line was the context.ts:103 comment). The claim generalized from that single stored line without checking the other 9. Both the original and the corrected report queried the same commit (e29cb7a1) correctly — the error was evidence completeness, not a wrong git ref.

**The 2 OTHER cases (`2b9b331ed61e8fce`, `6cb66c55da1a16af`)** — described literally in `rootcause-2gaps.md`, not investigated further. Both are partial path matches (a path-shaped candidate token substring-matched several nodes' file paths; none of those nodes' names appear as an exact token in the query). Affects the aggregate conclusion: **no** — both are variants of the already-dominant MULTI_TOKEN_QUERY phenomenon (10/12 of this bucket), not a new pattern.

**Tally:** confirmed_defects: 2 · reclassified_correct_behavior: 0 · undetermined: 0.

**Proposed ledger line (NOT applied — text only, see `rootcause-2gaps.json:proposed_ledger_line`):**

> Item: nca_ask indexer coverage — 2 confirmed indexer gaps in the September SYNIO index (of 26 originally-flagged recall-gap queries): (1) .tsx files are parsed with the plain (non-JSX) TypeScript grammar (src/parser.ts:239 reuses the .ts parser instance for .tsx instead of tree-sitter-typescript's dedicated .tsx grammar), causing JSX-containing top-level declarations to be dropped while non-JSX inner functions in the same file still get indexed — reproduced exactly against the frozen index's own node set for ActivateCompanyWizard.tsx (11/11 nodes match). (2) A second case (withRLSContext, a plain .ts arrow-function-via-middleware() pattern) is confirmed missing despite provably resolving a name under the CURRENT src/parser.ts logic — mechanism unresolved (possible scan-time parser version drift), reported as an open scan/parser frontier question, not concluded. Status: NOT_ACTED_ON — evidence only, no fix applied, per task scope.
