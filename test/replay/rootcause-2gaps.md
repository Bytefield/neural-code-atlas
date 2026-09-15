# Root cause: the 2 confirmed indexer coverage gaps + the 2 OTHER matcher cases

Evidence rule: Every source claim below is read from git object e29cb7a1 exclusively (git show / git grep against the commit), never the synio working tree.

## withRLSContext — all 10 occurrences at e29cb7a1

| file | line | text |
|---|---|---|
| src/server/trpc/context.ts | 103 | "// by the withRLSContext tRPC middleware on companyProcedure and staffProcedure." |
| src/server/trpc/context.ts | 175 | "// RLS context is set per-request inside a transaction by withRLSContext middleware." |
| src/server/trpc/init.ts | 363 | "const withRLSContext = t.middleware(async ({ ctx, next }) => {" |
| src/server/trpc/init.ts | 408 | "* Wraps the entire handler in a transaction with RLS GUC set (withRLSContext)." |
| src/server/trpc/init.ts | 424 | "* and DB layer (RLS policies via withRLSContext)." |
| src/server/trpc/init.ts | 429 | ".use(withRLSContext);" |
| src/server/trpc/init.ts | 432 | "* Middleware: Saga variant — validates company access like withRLSContext but does NOT" |
| src/server/trpc/init.ts | 583 | "* Platform roles (superuser/agent/manager) use prismaAdmin (BYPASSRLS) so withRLSContext is a no-op." |
| src/server/trpc/init.ts | 591 | ".use(withRLSContext);" |
| tests/security/billing/checkout-subscription-safety.test.ts | 165 | "// withRLSContext (added to staffProcedure) opens a $transaction and calls $executeRaw" |

### Which prior report was wrong, and what it actually inspected

drift.js's gitGrepExists() (used for the ORIGINAL 26-query drift classification) runs git grep against the same commit (e29cb7a1) but only stores the FIRST matching line as 'evidence' (out.trim().split('\n')[0]). git grep's output is ordered by file path; 'context.ts' sorts before 'init.ts' alphabetically, so the stored evidence was context.ts:103 (a comment) — 1 of 10 real occurrences. The later report generalized from that single stored line to 'only occurrence', without re-checking the other 9. Both reports queried commit e29cb7a1 correctly via git grep — the error was evidence completeness (first-match-only), not wrong-ref sourcing.

### AST / parser.ts verdict

Syntactic form: `const withRLSContext = t.middleware(async ({ ctx, next }) => { ... });`

tree-sitter node type: arrow_function (the value of t.middleware(...)'s sole argument)

NAMED by the declarator, not discarded: extractNodeName() walks arrow_function -> parent 'arguments' -> parent 'call_expression' -> parent 'variable_declarator', matches variable_declarator, resolves name='withRLSContext'. Contrast with the tRPC procedure-builder-chain candidates (companyProcedure, staffProcedure, protectedProcedure, publicProcedure) the prior task's report classified NON_INDEXABLE_BY_DESIGN: those have NO arrow_function/function_expression literal anywhere in their RHS at all (pure .use()-chain calls on an existing value) — this one has a real arrow_function literal as the sole call argument, which the same walk-up finds and names. Different syntactic shape, correctly different verdict.

### Three-step reasoning

a. YES — src/server/trpc/init.ts is a .ts file, .ncaignore keeps src/ for indexing, no exclusion applies.

b. YES — 9 nodes from this exact file exist in the September index (errorFormatter, errorTracking, csrf, isAuthed, validateCompanyAccess, isCompanyAdmin, isStaff, isSuperuser, rateLimit) — so the file was NOT skipped by the scan.

c. Declaration is of a supported construct type (arrow_function, confirmed by direct re-parse of the exact git blob with the same grammar and the same extractNodeName logic as src/parser.ts), other nodes from the same file exist, the specific target node is absent. INDEXABLE_CONSTRUCT_NO_NODE — CONFIRMED, not reclassified.

Mechanism certainty: UNRESOLVED. Unlike ActivateCompanyWizard (below), there is no grammar mismatch here — this file uses the correct .ts grammar and the construct provably resolves under the CURRENT src/parser.ts logic. Why the September scan specifically missed it (an older parser.ts version at scan time with different extractNodeName logic; an incremental-scan/cache skip; some other scan-time-specific cause) is not decided by this task — reported as a scan/parser frontier question, not concluded, per task scope.

## ActivateCompanyWizard

Real declaration: `src/components/companies/ActivateCompanyWizard.tsx:32`: "export function ActivateCompanyWizard({"

62 additional occurrences exist under graphify-out/ (a DIFFERENT, unrelated code-graph tool's cached output, tracked in the repo at this commit) — excluded here as not relevant to NCA's own indexing; graphify-out/graph.json independently labels this as "ActivateCompanyWizard()", corroborating it is an ordinary function, not evidence about NCA's indexer.

### Three-step reasoning

a. YES — .tsx is a scanned extension (parser.ts:239), src/ is kept per .ncaignore, no exclusion applies.

b. YES — 11 nodes from this exact file exist in the September index (onError, onError, onError, onSuccess, onError, handleStep1, found, handleStep2, handleStep3, onClick, onClick) — the file was scanned, not skipped.

c. Declaration is of a supported construct type (function_declaration). Other nodes from the same file exist. The specific target (the outer, JSX-returning function_declaration itself) is absent. INDEXABLE_CONSTRUCT_NO_NODE — CONFIRMED.

Mechanism certainty: RESOLVED. Re-parsing the exact git blob with the plain TypeScript grammar (matching src/parser.ts's actual .tsx handling) produces 125 ERROR nodes (hasError=true) — the grammar cannot cleanly parse this file's JSX. Only 11 function-type nodes survive anywhere in the whole file, all of them non-JSX-containing INNER arrow functions (event handlers) defined before the JSX return statement; the outer function_declaration whose body directly contains the JSX return is not recognized as a clean node. This reproduction's surviving node set is IDENTICAL to the September index's actual node set for this file (name+type+line, exact) — strong confirmation this is the real mechanism, not just a plausible one. The parser.ts rule responsible: parser.ts:239 (`this.parsers.set('tsx', p)`) reuses the plain-TypeScript-grammar parser instance for .tsx, instead of tree-sitter-typescript's separate .tsx grammar export. This mismatch is a property of the .tsx extension generally, not specific to this one file — not investigated further here (out of this task's scope), but the mechanism itself is general, not file-specific.

## The 2 OTHER cases

### 2b9b331ed61e8fce — `company-assistant retell agent prompt push update`

Literal pattern: partial path match — query contains path-shaped token(s) (company-assistant) that substring-matched multiple nodes' file paths; none of those nodes' NAMES appear as an exact token in the query text ('company-assistant retell agent prompt push update') — matched node names: loadCompanyConfigForPrompt, services, buildBeginMessage, createRetellAssistant, updateRetellAssistant, deleteRetellAssistant, createRetellLlm, updateRetellLlm, deleteRetellLlm, createRetellAgent, updateRetellAgent, deleteRetellAgent, buildRetellTools

query text does NOT equal any matched node.name exactly, and does NOT equal any matched node.file exactly or as its basename — match was via path-substring only (a path-kind candidate token found inside several nodes' file paths), not an exact name or exact path match.

Affects aggregate conclusion: no — Both are variants of the same already-dominant MULTI_TOKEN_QUERY phenomenon (multi-word query, AND-across-terms semantics), just reached via a path-substring candidate instead of a name candidate. Neither changes the counts for INDEXABLE_CONSTRUCT_NO_NODE / NON_INDEXABLE_BY_DESIGN, nor introduces a new EXACT_*_MISSED case (no exact match exists for either). The dominant finding for NODE_PRESENT_MATCHER_MISSED (10/12 MULTI_TOKEN_QUERY, an interface-contract question, not a matcher defect) is unchanged.

### 6cb66c55da1a16af — `vapi tools manage-appointment build-prompt token-estimator`

Literal pattern: partial path match — query contains path-shaped token(s) (manage-appointment, build-prompt, token-estimator) that substring-matched multiple nodes' file paths; none of those nodes' NAMES appear as an exact token in the query text ('vapi tools manage-appointment build-prompt token-estimator') — matched node names: buildPrompt, includedSections, prompt, createDentalConfig, sumOfSections, estimateTokens

query text does NOT equal any matched node.name exactly, and does NOT equal any matched node.file exactly or as its basename — match was via path-substring only (a path-kind candidate token found inside several nodes' file paths), not an exact name or exact path match.

Affects aggregate conclusion: no — Both are variants of the same already-dominant MULTI_TOKEN_QUERY phenomenon (multi-word query, AND-across-terms semantics), just reached via a path-substring candidate instead of a name candidate. Neither changes the counts for INDEXABLE_CONSTRUCT_NO_NODE / NON_INDEXABLE_BY_DESIGN, nor introduces a new EXACT_*_MISSED case (no exact match exists for either). The dominant finding for NODE_PRESENT_MATCHER_MISSED (10/12 MULTI_TOKEN_QUERY, an interface-contract question, not a matcher defect) is unchanged.

## Summary

confirmed_defects: 2 · reclassified_correct_behavior: 0 · undetermined: 0

## Proposed ledger line (NOT applied)

```
Item: nca_ask indexer coverage — 2 confirmed indexer gaps in the September SYNIO index (of 26 originally-flagged recall-gap queries): (1) .tsx files are parsed with the plain (non-JSX) TypeScript grammar (src/parser.ts:239 reuses the .ts parser instance for .tsx instead of tree-sitter-typescript's dedicated .tsx grammar), causing JSX-containing top-level declarations to be dropped while non-JSX inner functions in the same file still get indexed — reproduced exactly against the frozen index's own node set for ActivateCompanyWizard.tsx (11/11 nodes match). (2) A second case (withRLSContext, a plain .ts arrow-function-via-middleware() pattern) is confirmed missing despite provably resolving a name under the CURRENT src/parser.ts logic — mechanism unresolved (possible scan-time parser version drift), reported as an open scan/parser frontier question, not concluded. Status: NOT_ACTED_ON — evidence only, no fix applied, per task scope.
```
