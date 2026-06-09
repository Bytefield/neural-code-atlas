# Neural Code Atlas (NCA)

> Local project intelligence for AI-assisted development: indexes code structure
> and documentation together in a single SQLite database, exposes graph analytics
> (Louvain communities, PageRank, god nodes) and full-text search via CLI and
> MCP server — so AI assistants get precise structural and contextual answers,
> not similarity guesses.

NCA scans your repo, builds a persistent SQLite index of code nodes (functions,
classes, modules) AND documentation (markdown files, architecture docs, personal
notes), and exposes both via CLI and MCP server. One database, unified context
for code structure and the reasoning behind it.

## Why

On medium/large codebases, "similarity search" often returns text that looks relevant but isn't on the actual execution path. NCA is built for structural questions:

- "Where does `handleRequest` go next?"
- "What calls this function?"
- "What are the hot nodes people keep querying?"
- "Which modules are getting too coupled?"

Beyond point queries, NCA understands your codebase as a graph. Each scan computes:

- **Community detection** (Louvain) — which files form natural modules based on coupling
- **PageRank centrality** — which nodes are structurally important across the whole graph
- **Betweenness centrality** — which nodes are bottlenecks that everything routes through
- **God node detection** — which nodes have disproportionate coupling and are at risk of becoming liabilities

This lets you ask architecture-level questions: which modules are drifting toward coupling, where are the load-bearing nodes, what does the dependency topology actually look like?

It's local-first: no cloud indexing, no embeddings, no API calls.

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
# → builds index, writes .nca/SKILL.md alongside the database

nca ask "authentication middleware"
# → returns ranked nodes with module, PageRank position, god-node flag

nca flow handleRequest
# → traces execution path from entry point

nca evolve
# → emits architectural warnings (high complexity, cycles, deep chains, god nodes)

nca status
# → shows node/file/flow counts and DB location
```

After scanning, `SKILL.md` is written to your project root. Drop it into your Claude Code context to give the AI an accurate structural map of the codebase before asking questions.

## Commands

### Code navigation
- `nca ask <query...>` — query the index by symbol or keyword; returns code nodes with module, PageRank rank, and god-node flags (`--json` for structured output)
- `nca flow <name>` — trace execution flow from an entry point; shows all nodes reachable in dependency order (`--json` supported)
- `nca evolve` — run architectural analysis and emit warnings (high complexity, cycles, deep chains, god nodes)

### Vault & documentation
- `nca vault scan <path>` — index an Obsidian/Markdown vault with FTS5 full-text search
- `nca vault search <query>` — search indexed vault docs; returns matched files with excerpts (`--root <vault_path>` to override auto-detected vault)
- `nca vault get <id_or_path>` — retrieve a specific note by ID or file path (`--root <vault_path>`)
- `nca related <symbol_or_doc>` — show documentation referencing a code symbol, or code symbols referenced by a doc; traverses doc↔code edges (`--root <vault_path>`)
- `nca docs audit` — generate documentation coverage report (shows indexed docs and metrics)

### Context compiler
- `nca task [description]` — set the active task (stored in `.nca/current-task.json`); supply a description or omit to read current task
- `nca task --show` — print the current task
- `nca task --clear` — clear the current task
- `nca brief [--light]` — generate a focused context brief for the active task; `--light` emits a compact version (≤300 tokens)

### Index management
- `nca scan [path]` — build/update the index; auto-generates `SKILL.md` (defaults to cwd)
- `nca status` — show index stats (node count, file count, DB location, last scan time)
- `nca watch [path]` — watch filesystem and auto-reindex on change (requires `chokidar`)
- `nca insights` — show the most frequently queried nodes
- `nca projects` — list all registered projects

### Server
- `nca mcp` — run MCP server over stdio (Claude Code integration)

### Orientation telemetry (opt-in, local-first)
- `nca metrics orientation` — per-session + cross-session summary of orientation cost (the variance of search/read activity before the first edit)
- `nca metrics orientation --purge --older-than <days>` — prune old local events

Local measurement only; nothing leaves the machine and no raw prompt or tool
input is stored. Install the capture hooks and read the schema in
[docs/orientation-telemetry.md](docs/orientation-telemetry.md).

Run `nca <command> --help` for full options per command.

## Graph Analytics

Every `nca scan` runs a full graph analysis pass on the dependency graph. Results are stored in the index and surfaced automatically in `nca ask` output and `SKILL.md`.

### Community detection (Louvain)

Groups files into modules based on import/call coupling, without requiring you to define module boundaries. Useful for spotting when two areas of the codebase are more entangled than they should be.

### PageRank centrality

Scores every node by how many other important nodes depend on it. High-PageRank nodes are load-bearing — changes there ripple widely. Shown as `#N of M` in `nca ask` output.

### Betweenness centrality (Brandes)

Identifies nodes that sit on the most shortest paths between other nodes. High betweenness = structural bottleneck. Even a low-complexity function can be high-betweenness if everything routes through it.

### God node detection

Flags nodes whose coupling (in-degree + out-degree) exceeds the p95 threshold of the graph. These are the nodes that "know too much." Shown as `gn:yes|score:<n>` or `gn:no` in query results.

```bash
nca ask "storage layer"
# example output includes:
#   gn:yes|score:0.94   ← this node has disproportionate coupling
#   rank:#3 of 224      ← 3rd by PageRank out of 224 nodes
#   module:src/storage  ← directory-level module name
```

## Project Intelligence

`nca scan` automatically indexes all markdown files in your repo alongside
code nodes — READMEs, changelogs, architecture docs, and any personal notes
in a gitignored `notes/` folder. One database, unified context.

`nca_ask` returns unified results: code nodes AND relevant documentation
excerpts in a single query. Ask about a concept and get both where it lives
in the code and what your docs say about it.

## SKILL.md

`nca scan` writes `.nca/SKILL.md` alongside the database. It is a structured, token-efficient codebase map that covers:

- **Module list** — node counts per top-level directory
- **Top 20 nodes by PageRank** — name, fanIn, fanOut, complexity
- **God nodes** — with coupling scores
- **Issues** — cycle count and deep chain count
- **Docs** — all indexed markdown files with titles and paths (new in 1.3.0)

### Using SKILL.md with Claude Code

Add it to your project's context before asking architectural questions:

```
/add .nca/SKILL.md
nca_ask(query="what handles auth")
```

Or reference it in your `CLAUDE.md`:

```markdown
Read SKILL.md before asking NCA questions — it gives accurate module boundaries
and flags god nodes to avoid touching carelessly.
```

`SKILL.md` is regenerated on every scan and is safe to gitignore or commit — it contains no secrets, only structural metadata.

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

NCA autodetects the project from the working directory. To target a specific project per-call, pass the optional `project` parameter:

```
nca_ask(query="handler", project="/mnt/c/dev/synio")
nca_status(project="synio")
```

Tools exposed by the MCP server:

- `nca_ask` — query code and docs by name or keyword; returns code nodes with module/PageRank/god-node context, plus documentation excerpts. If no symbols match, falls back to searching by file path (marked `[PATH_MATCH]`). If both symbol and path searches fail, returns a guidance message
- `nca_flow` — trace execution flow from an entry point
- `nca_status` — show index stats
- `nca_evolve` — run architectural heuristics
- `nca_insights` — show frequently queried nodes
- `nca_projects` — list all indexed projects
- `nca_vault_scan` — index an Obsidian/Markdown vault

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

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full history.

Recent highlights:

- **1.3.0** — Project Intelligence: unified code + documentation indexing, nca_ask returns code and docs together, SKILL.md Docs section
- **1.2.1** — canonical path resolution (`realpathSync`) prevents duplicate indexing across WSL/Windows/symlinks
- **1.2.0** — graph analytics (Louvain, PageRank, betweenness, god nodes), SKILL.md, enriched `nca_ask` responses
- **1.1.1** — vault scanning with FTS5, YAML frontmatter support, incremental updates
- **1.1.0** — node identity fix (same-name functions across files), multi-project MCP, stale node cleanup

## License

MIT
