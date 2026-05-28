# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] — 2026-05-28

### Added
- **Louvain community detection** (PR #26): custom implementation detects module communities in
  the dependency graph; community IDs are stored per node and exposed in analysis output.
- **PageRank centrality** (PR #26): custom iterative PageRank scores every node; rank position
  (e.g. `#3 of 42`) is surfaced in `nca ask` responses.
- **Betweenness centrality** (PR #26): Brandes algorithm computes betweenness for all nodes;
  identifies structural bottlenecks in the dependency graph.
- **God node detection** (PR #26): percentile-based heuristic (default p95) flags nodes with
  disproportionate coupling; `gn:yes|score:<n>` or `gn:no` appears in `nca ask` output.
- **SKILL.md auto-generated codebase map** (PR #25): `nca scan` produces a `SKILL.md` at the
  project root summarising architecture, hot nodes, god nodes, community clusters, entry points,
  and key patterns — ready for use as Claude Code context.
- **Enriched `nca_ask` responses** (PR #27): each result now includes the directory-level module
  name, PageRank position, and god node flag so callers get richer structural context without
  extra round-trips.

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
