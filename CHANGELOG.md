# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- `NCA_MODE` environment reader — `off` (case-insensitive) disables the
  session hooks; any other value (including unset) leaves them on
- PostToolUse hook (`dist/hooks/post-tool-use.js`) — structured session
  logging to `.nca/sessions/<session_id>.json`, append-only under an atomic
  lock with a hard timeout; never breaks the Claude Code session
- Stop hook (`dist/hooks/stop.js`) — one-line per-turn navigation summary
  (briefs, grep/glob with after-brief and blocked detail, reads)
- `nca session report` — per-session tool usage and behavior report
  (`--all`, `--json`)
- `nca compare` — side-by-side comparison of two logged sessions (`--json`)

### Notes
- The `blocked` field is reserved for a forthcoming PreToolUse hook; the
  PostToolUse path always records `blocked: false`.

---

## [1.5.1] — 2026-06-08

### Fixed
- `nca brief` now auto-resolves vault root from `.nca/config.local.json` — no longer requires the `--root` flag when a vault is configured

---

## [1.5.0] — 2026-06-08

### Added
- `nca vault search` and `nca vault get` CLI commands
  for querying indexed Obsidian/Markdown vaults
- `nca related <symbol_or_doc>` — traverse doc↔code edges
- `nca docs audit` — documentation coverage report
  (documented %, top undocumented by PageRank, orphaned docs)
- `nca task` — declare active task intent for context compilation
- `nca brief --light` — generate focused task brief (≤300 tokens)
  with relevant symbols, docs, and gotchas

### Fixed
- Migration schema version mismatch: binary built against v3
  could not open v4 DBs created by development builds

### Architecture
- Established motor/compiler boundary (src/compiler/)
- Per-repo doc sources configuration (.nca/config.json)
- ensureIndexed guard with hook-aware routing (--from-hook flag)

---

## [1.4.0] — 2026-06-01

### Added
- **Path fallback in `nca_ask`** (PR #39): when a query does not match any code symbols,
  the tool now falls back to searching by file path (LIKE on the `file` column). Results
  are marked with `[PATH_MATCH]` to distinguish them from symbol matches. If both symbol
  and path searches fail, a guidance message is emitted. JSON output includes `pathFallback`
  and `guidance` fields for MCP consumers.

### Changed
- **MCP tool dispatch refactored** (PR #38): `handleToolCall` replaced with a typed dispatch
  map per tool, reducing cyclomatic complexity from 16 to 5 and improving maintainability.
- **Parser architecture refactored** (PR #40): extracted `LanguageExtractor` interface with
  TypeScript and Python implementations. Provides a foundation for multi-language support
  and simplifies the addition of new parsers.

### Tests
- **Parser characterization tests** (TS-CHAR-01, PY-CHAR-01): golden output tests for TypeScript
  and Python parsing, capturing function/class/method/return-type extraction.
- **Migration scenario coverage** (MIG-09, MIG-10, MIG-11): v2→v3 incremental upgrade, invalid
  schema_version detection (NaN and negative values), and transactional rollback guarantee
  verified via induced migration failure.

---

## [1.3.3] — 2026-05-31

### Fixed
- Purge stale note IDs before re-indexing to handle format migration from
  filename-based to path-hash-based IDs. Fixes UNIQUE constraint violations
  on large repos with same-named markdown files (PR #36).

---

## [1.3.2] — 2026-05-29

### Fixed
- fix: derive note ID from full path hash to prevent UNIQUE constraint violations when scanning repos with same-named markdown files in different directories

---

## [1.3.1] — 2026-05-29

### Changed
- docs: README updated to reflect 1.3.0 capabilities (Project Intelligence)

---

## [1.3.0] — 2026-05-29

### Added
- **Project Intelligence Fase 1** (PR #29): `nca scan` now indexes Markdown notes alongside code. Vault schema (migration 003) enables FTS5 search on note chunks. `scan` output includes notes count.
- **Project Intelligence Fase 2** (PR #30): `nca_ask` and the MCP `nca_ask` tool return unified code + documentation context. Notes matching the query appear in a `[DOCS]` section after code results, with title, file path, and excerpt. FTS5 prefix queries handle stemming variants.
- **Project Intelligence Fase 3** (PR #31): `SKILL.md` now includes notes count in the header and a new `## Docs` section listing up to 20 indexed notes with relative paths and titles.

---

## [1.2.1] — 2026-05-28

### Fixed
- **Canonical path resolution** (PR #28): `fs.realpathSync()` is now applied at the `scan`
  entry point after path validation. Prevents duplicate node indexing that occurred when the
  same DB was scanned from WSL, Windows-native, and symlinked paths.

---

## [1.2.0] — 2026-05-28

### Added
- **Louvain community detection** (PR #21): custom implementation detects module communities in
  the dependency graph; community IDs are stored per node and exposed in analysis output.
- **PageRank centrality** (PR #22): custom iterative PageRank scores every node; rank position
  (e.g. `#3 of 42`) is surfaced in `nca ask` responses.
- **Betweenness centrality** (PR #23): Brandes algorithm computes betweenness for all nodes;
  identifies structural bottlenecks in the dependency graph.
- **God node detection** (PR #24): percentile-based heuristic (default p95) flags nodes with
  disproportionate coupling; `gn:yes|score:<n>` or `gn:no` appears in `nca ask` output.
- **SKILL.md auto-generated codebase map** (PR #25): `nca scan` produces a `SKILL.md` at the
  project root summarising architecture, hot nodes, god nodes, community clusters, entry points,
  and key patterns — ready for use as Claude Code context.
- **Enriched `nca_ask` responses** (PR #26): each result now includes the directory-level module
  name, PageRank position, and god node flag so callers get richer structural context without
  extra round-trips.

---

## [1.1.2] — 2026-05-27

### Fixed
- **`chunkBody` infinite loop on oversized paragraphs** (PR #20): paragraphs exceeding the
  chunk size no longer cause an infinite loop; they are sliced into finite-length segments.

---

## [1.1.1] — 2026-05-27

### Added
- **Vault scanning** (PR #18): `nca vault scan <path>` indexes Obsidian/Markdown vaults into
  a dedicated SQLite schema with FTS5 full-text search. Notes are parsed for YAML frontmatter
  (`id`, `type`, `status`, `area`, `summary`, `updated`) and body chunks (~1000 chars with
  paragraph overlap for context-aware retrieval).
- **Markdown parser** (PR #18): `src/vault/parser.ts` extracts frontmatter and splits body into
  overlapping chunks; `src/vault/scanner.ts` walks the vault directory (excluding `.obsidian/`)
  and detects modified notes via SHA-256 content hash.
- **Vault schema** (PR #18): migration 3 adds `vault_notes`, `vault_chunks`, and
  `vault_chunks_fts` (FTS5) tables.

---

## [1.1.0] — 2026-05-26

### Fixed
- **Node identity collision** (PR #15): `GraphSnapshot` indexed nodes by bare name, causing
  functions with the same name across different files to be treated as a single node — producing
  false edges, false cycles, and corrupted analysis. Node identity is now `file:name`
  (e.g. `src/auth/login.ts:handler`). Dependency resolution uses same-file lookup first, then
  global-unique fallback; unresolvable edges are skipped with no false positives.
- **Stale nodes after file deletion** (PR #13): nodes and edges for files deleted from disk were
  retained in the index indefinitely. The watcher now purges all nodes belonging to an unlinked
  file on the next scan cycle.

### Changed
- MCP server: `NCA_DB_PATH` env var is now an optional fallback (resolution order: `project`
  arg → `NCA_DB_PATH` → cwd autodetect). Passing `project` directly is the recommended approach
  for multi-project setups.
- `nca` CLI and MCP server now read the version from `package.json` at runtime; no more
  hardcoded version strings in `src/cli.ts` or `src/mcp.ts`.
- `package-lock.json` regenerated with corrected package name (`@synio-es/neural-code-atlas`)
  and version.

### Docs
- README and `INSTALL.md` install instructions corrected to `@synio-es/neural-code-atlas`.
- `nca_projects` MCP tool documented in README.
- Index lifecycle guide added to README (PR #14).

---

## [1.0.2] — 2026-05-?

### Changed
- Author metadata updated to use real name in `package.json`.

> No functional changes.

---

## [1.0.1] — 2026-05-?

### Added
- **Multi-project MCP support** (PR #10): stateless MCP server with project registry and LRU
  cache; each tool call targets a project via the `project` parameter.
- **`nca mcp` command**: convenience CLI entry point to launch the MCP stdio server.
- **Human-readable CLI output** (PR #9): coloured, structured output for `nca ask`, `nca status`,
  `nca evolve`, and related commands.
- **Migrations infrastructure** (PR #2): versioned SQLite schema migrations; `nca migrate` command.

### Fixed
- Line-move duplicates and DB repair via migration 002 (PR #3).
- Cycle-aware chain detection in `nca flow` (PR #4).
- Watch unlink handler now relinks the graph after a file is deleted and re-created (PR #7).
- MCP test race condition on Windows (PR #8): added 500 ms startup delay, extended eval timeout,
  and switched shutdown to `stdin.end()` (graceful EOF) before force-kill.

### Performance
- Batch `node_scores` lookups in `rankWithBoost` — heuristic scoring with context expansion
  (PR #5).
- Eliminated redundant file read in scanner (PR #6).

### Refactored
- Introduced `GraphSnapshot` to consolidate graph construction into an immutable per-analysis
  object (PR #1).

### Changed
- Package published under `@bytefield/neural-code-atlas`, then moved to
  `@synio-es/neural-code-atlas`.

---

## [1.0.0] — 2026-05-?

Initial release. Tree-sitter + SQLite semantic index for TypeScript, JavaScript, and Python
codebases. Core commands: `nca scan`, `nca ask`, `nca status`, `nca evolve`, `nca flow`.

Static analysis rules: R001 (high complexity), R002 (too many parameters), R003 (too many
dependencies), R004 (cycles), R005 (deep dependency chains), R006 (isolated nodes).
