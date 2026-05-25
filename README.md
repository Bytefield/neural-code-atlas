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
npm i -g neural-code-atlas
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
      "args": ["mcp"],
      "env": {
        "NCA_DB_PATH": "/path/to/your-project/.nca/nca.db"
      }
    }
  }
}
```

Tools exposed by the MCP server:
- `nca_ask`
- `nca_flow`
- `nca_status`
- `nca_evolve`
- `nca_insights`

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

## Git hook (optional)

Re-index automatically after each commit:

```bash
cp .git-hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

## License

MIT
