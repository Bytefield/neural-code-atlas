# Backlog

Gaps found during development that are out of scope for the change that surfaced them.

## Open

### Flaky / environment-sensitive tests in `test/run.js`

Found while verifying `fix/ask-scope-flows`. Both fail on a clean `HEAD` (5608737), so they are independent of that change. Measured on WSL over `/mnt/c`, 3 runs on a clean copy of `HEAD`:

| Test | Clean `HEAD` | Cause |
|------|--------------|-------|
| `AC3 cache hit re-scan is fast` | failed 2 of 3 runs (e.g. 1054 ms vs a 1000 ms limit) | Hard timing threshold; file I/O over `/mnt/c` is slow and noisy |
| `AC5 MCP server (tools/list + nca_insights)` | failed 3 of 3 runs ("Expected ≥2 MCP response lines, got 0") | Fixed 3 s window is shorter than MCP server startup in this environment |

Proposed fix: make the AC5 window wait for the expected response lines with a generous timeout (the AF tests already use 15 s and pass), and make the AC3 threshold relative to the cold scan or run it from a non-`/mnt/c` path. Until then `npm test` exits 1 in this environment.

### Cap or rank flows for hub symbols in `nca_ask`

`getFlowsForSymbols()` removes the global flow dump, but a match on a symbol that sits in many flows still returns all of them under `[F]`. In this repo's own DB, `search` appears in 31 of 49 flows and `getAllFlows` in 31 of 49.

Deliberately left out of `fix/ask-scope-flows` (scoping only, no new ranking). To do: cap the number of flows per response and/or rank them (for example by position of the matched symbol in the chain, or by flow length). Revisit when ranking work is planned; the Phase 1 label comes from the request and is not recorded anywhere else in this repo.

Also not measured: the replay classifier only flags flow dumps on no-match queries, so noise from flows attached to direct hits is untracked.
