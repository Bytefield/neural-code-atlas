# Neural Code Atlas (NCA)

> Local semantic index for codebases: tree-sitter + SQLite + CLI + MCP server.

NCA scans your repo, builds a persistent SQLite index of structural nodes (functions, classes, modules), and lets you query it via CLI or via an MCP server so AI assistants can retrieve precise context without brute-force grep.

## Why

On medium/large codebases, “similarity search” often returns text that looks relevant but isn’t on the actual execution path. NCA is built for structural questions:

- “Where does `handleRequest` go next?”
- “What calls this function?”
- “What are the hot nodes people keep querying?”
- “Which modules are getting too coupled?”

It’s local-first: no cloud indexing required.

## Install

```bash
npm i -g @synio-es/neural-code-atlas
nca --help
```

If install fails, see `INSTALL.md` (native build tools for `better-sqlite3`/`tree-sitter`).

## Quick start

```bash
cd your-project
nca scan .

nca ask "authentication middleware"

nca flow handleRequest

nca status
```

## Commands

- `nca scan [path]` — build/update the index (defaults to cwd)
- `nca ask <query...>` — query the index (`--json` for structured output)
- `nca flow <name>` — trace execution flow from an entry point (`--json` supported)
- `nca evolve` — run architectural heuristics and emit warnings
- `nca status` — show index stats
- `nca watch [path]` — watch filesystem and auto reindex
- `nca insights` — show the most frequently queried nodes
- `nca mcp` — run MCP server over stdio (Claude Code integration)

Run `nca <command> --help` for options.

## MCP server (Claude Code integration)

After installing NCA, configure Claude Code to run the MCP server:

```json
{
  "mcpServers": {
    "nca": {
      "command": "nca",
      "args": ["mcp"]
    }
  }
}
```

NCA autodetects the project from the working directory. To target a specific project
per-call, pass the optional `project` parameter to any tool:

```
nca_ask(query="handler", project="/mnt/c/dev/synio")
nca_status(project="synio")
```

Tools exposed by the MCP server:
- `nca_ask` — query nodes by name or keyword
- `nca_flow` — trace execution flow from an entry point
- `nca_status` — show index stats
- `nca_evolve` — run architectural heuristics
- `nca_insights` — show frequently queried nodes
- `nca_projects` — list all indexed projects

## Configuration (`.nca/config.json`)

Create `.nca/config.json` in your project root:

```json
{
  "exclude": ["generated", "vendor"],
  "include_extensions": [".ts", ".js", ".py"],
  "max_file_size_kb": 256,
  "evolve": {
    "complexityThreshold": 10,
    "maxParamsThreshold": 7,
    "maxDepsThreshold": 15,
    "maxChainDepth": 6
  }
}
```

## Supported languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`)

## Keeping the index up to date

`nca scan` is not free — run it deliberately, not on every save.

| Situation | Action |
|-----------|--------|
| First time on a repo | `nca scan <root>` once |
| Moved/renamed modules, large refactor, changed imports/exports | `nca scan <root>` |
| Small edits (bug fix, adding a function) | Not needed; only if results look stale |
| Long iterative session | `nca watch <root>` — auto-reindexes on save |
| Before using NCA after a gap (days/weeks) | `nca status` first — rescan if index looks old |

**Rule of thumb for AI agents:** run `nca status` before querying. If the index is missing or the last scan predates significant changes, run `nca scan`. Never scan unconditionally on every invocation.

## Git hook (optional)

Re-index automatically after each commit:

```bash
cp .git-hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

## What's new in 1.1.1

- **Vault scanning**: `nca vault scan <path>` indexes an Obsidian or Markdown vault with FTS5
  full-text search. Notes are chunked (~1000 chars with paragraph overlap) for context-aware
  retrieval.
- **Frontmatter support**: YAML frontmatter fields (`id`, `type`, `status`, `area`, `summary`,
  `updated`) are parsed and stored alongside note content.
- **Incremental updates**: content is hashed (SHA-256) so only modified notes are re-indexed
  on subsequent scans.

## What's new in 1.1.0

- **Node identity fix**: functions with the same name in different files are now correctly
  treated as separate nodes. Previously they were merged, creating false dependencies and
  corrupted analysis results.
- **Multi-project support**: MCP tools accept an optional `project` parameter. No need to
  configure `NCA_DB_PATH` — autodetects from the working directory.
- **`nca_projects` tool**: list all indexed projects via MCP.
- **Stale node cleanup**: deleted files are now properly purged from the index on rescan.
- **Stale index warnings**: tool responses warn if the index is more than 7 days old.

## License

MIT
