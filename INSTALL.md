# Neural Code Atlas — Install Guide

## Requirements

- Node.js >= 18
- Python build tools (for tree-sitter native bindings): `python3`, `make`, `g++`
  - Ubuntu/Debian: `sudo apt install python3 build-essential`
  - macOS: `xcode-select --install`
  - Windows: `npm install --global windows-build-tools`

## Install

```bash
cd /path/to/nca
npm install
npm run build
npm link          # makes `nca` available globally
```

## First scan

```bash
cd /path/to/your-project
nca scan .
```

## Usage

```bash
# Scan and index a codebase
nca scan [path]              # defaults to cwd

# Query the index
nca ask <query>              # e.g. nca ask "authentication middleware"
nca ask <query> -p /path     # specify project root

# Trace execution flow
nca flow <entry_point>       # e.g. nca flow handleRequest

# Architectural analysis
nca evolve                   # emit warnings (complexity, cycles, etc.)

# Hot nodes — most frequently queried
nca insights                 # top 10 nodes by query frequency
nca insights --json          # structured JSON output

# Index status
nca status

# Watch for file changes and auto-reindex
nca watch [path]             # defaults to cwd
nca watch [path] -v          # verbose (log each reindexed file)
```

## MCP Server (Claude Code integration)

Add to your Claude Code config (`~/.claude/settings.json` or `.claude/settings.json`):

```json
{
  "mcpServers": {
    "nca": {
      "command": "node",
      "args": ["/path/to/nca/dist/mcp.js"],
      "env": {
        "NCA_DB_PATH": "/path/to/your-project/.nca/nca.db"
      }
    }
  }
}
```

Or using `npx` after publishing:

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

## Configuration (.nca/config.json)

Create `.nca/config.json` in your project root to customize behavior:

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
| `exclude` | `[]` | Extra directories to skip during scan |
| `include_extensions` | `.ts .tsx .js .jsx .mjs .cjs .py` | File extensions to index |
| `max_file_size_kb` | `512` | Skip files larger than this |
| `evolve.complexityThreshold` | `10` | R001 cyclomatic complexity limit |
| `evolve.maxParamsThreshold` | `7` | R002 max function parameters |
| `evolve.maxDepsThreshold` | `15` | R003 max dependency count |
| `evolve.maxChainDepth` | `6` | R005 max dependency chain depth |

## Git Hook (auto re-index on commit)

```bash
cp .git-hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

## Environment Variables

| Variable      | Default                  | Description              |
|---------------|--------------------------|--------------------------|
| `NCA_DB_PATH` | `<cwd>/.nca/nca.db`      | Path to NCA SQLite DB    |

## Output Format

All NCA output follows the contract:

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

## Performance

| Operation       | Target   |
|-----------------|----------|
| scan 200 files  | < 3000ms |
| query           | < 200ms  |
| cache hit scan  | < 100ms  |

## Warning Rules

| Rule | Description                        |
|------|------------------------------------|
| R001 | Function complexity >= 10          |
| R002 | Function params > 7                |
| R003 | Too many dependencies > 15         |
| R004 | Cyclic dependency detected         |
| R005 | Deep dependency chain > 6          |
| R006 | Isolated node (no callers/deps)    |

## Supported Languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`)
