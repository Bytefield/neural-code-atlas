# Neural Code Atlas (NCA)

> Local semantic index layer for codebases. Built for Claude Code via MCP.

NCA scans your codebase with tree-sitter, builds a persistent SQLite index of every function, class, and module, and exposes it through a CLI and an MCP server — so your AI assistant always has precise structural context, not just keyword matches.

---

## Why NCA?

LLMs lose context on large codebases. Embedding-based tools (Cursor, Copilot) work by similarity — they find text that *looks like* your query. NCA works structurally: it parses your code, understands the dependency graph, and traces execution flows. The result is faster, more precise context retrieval with zero cloud dependency.

|                        | NCA | Cursor / Copilot | ctags + ripgrep |
|------------------------|-----|-----------------|-----------------|
| Local / no cloud       | ✅  | ❌              | ✅              |
| Structural (tree-sitter) | ✅ | ❌             | ✅              |
| Semantic query         | ✅  | ✅              | ❌              |
| MCP server             | ✅  | ❌              | ❌              |
| Dependency graph       | ✅  | ❌              | ❌              |
| Execution flow tracing | ✅  | ❌              | ❌              |
| Architectural warnings | ✅  | ❌              | ❌              |

---

## Install

```bash
npm install -g neural-code-atlas
```

Or run without installing:

```bash
npx neural-code-atlas scan .
```

**Requirements:** Node.js >= 18, Python 3 + build tools (for tree-sitter native bindings)

```bash
# Ubuntu/Debian
sudo apt install python3 build-essential

# macOS
xcode-select --install
```

---

## Quick start

```bash
cd your-project
nca scan .                         # index the codebase
nca ask "authentication middleware" # semantic query
nca flow handleRequest             # trace execution
nca evolve                         # architectural warnings
```

---

## Commands

```bash
nca scan [path]              # scan and index (defaults to cwd)
nca scan [path] -v           # verbose scan output

nca ask <query>              # semantic query against the index
nca ask <query> -p /path     # specify project root
nca ask <query> --json       # structured JSON output

nca flow <entry_point>       # trace execution flow from a function/method

nca evolve                   # emit architectural warnings
nca insights                 # top 10 most queried nodes
nca insights --json          # structured JSON output

nca status                   # index stats (files, nodes, flows)
nca watch [path]             # watch for changes and auto-reindex
nca watch [path] -v          # verbose watch output
```

---

## Keeping the index up to date

- After meaningful code changes: run `nca scan .` (or `nca scan <project-root>`).
- During active development: run `nca watch .` in the background to keep the DB fresh.
- If you query multiple projects in one Claude session: use the MCP tool param `project` (or run `nca_projects` to discover indexed roots) to avoid hitting the wrong DB.

## MCP Server (Claude Code integration)

Add to your Claude Code config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "nca": {
      "command": "npx",
      "args": ["-y", "neural-code-atlas", "mcp"],
      "env": {
        "NCA_DB_PATH": "/path/to/your-project/.nca/nca.db"
      }
    }
  }
}
```

Once configured, Claude Code can call `nca_query`, `nca_flow`, and `nca_evolve` directly to get precise structural context from your codebase.

---

## Output format

All NCA output follows a stable contract:

```
NCA|q:<query>|t:<timestamp_ms>
[N]
@<type>.<name>{m:<module>|i:<inputs>|o:<outputs>|d:<deps>|e:<effects>|cx:<complexity>|f:<file>:<line>}
[F]
#<flow_name>[<step>><step>><step>]
[W]
!<rule_id>:<node_id>:<detail>
[CTX]
entry:<file>:<line>|scope:<module>|confidence:<0-1>
```

---

## Configuration

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

| Field | Default | Description |
|-------|---------|-------------|
| `exclude` | `[]` | Extra directories to skip |
| `include_extensions` | `.ts .tsx .js .jsx .mjs .cjs .py` | Extensions to index |
| `max_file_size_kb` | `512` | Skip files larger than this |
| `evolve.complexityThreshold` | `10` | R001 cyclomatic complexity limit |
| `evolve.maxParamsThreshold` | `7` | R002 max function parameters |
| `evolve.maxDepsThreshold` | `15` | R003 max dependency count |
| `evolve.maxChainDepth` | `6` | R005 max dependency chain depth |

---

## Architectural warnings

`nca evolve` checks your codebase for structural issues:

| Rule | Description |
|------|-------------|
| R001 | Function complexity >= threshold |
| R002 | Function has too many parameters |
| R003 | Module has too many dependencies |
| R004 | Cyclic dependency detected |
| R005 | Deep dependency chain |
| R006 | Isolated node (no callers, no deps) |

---

## Supported languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`)

---

## Git hook (auto re-index on commit)

```bash
cp .git-hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

---

## Performance

| Operation | Target |
|-----------|--------|
| Scan 200 files | < 3000ms |
| Query | < 200ms |
| Cache hit re-scan | < 100ms |

---

## License

MIT © [DirtySpaniard](https://github.com/DirtySpaniard)
