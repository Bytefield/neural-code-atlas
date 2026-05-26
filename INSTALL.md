# Neural Code Atlas — Install Guide

## Quickstart (npm)

```bash
npm i -g @synio-es/neural-code-atlas
nca --help

nca scan .
nca ask "authentication middleware"
```

> Installing from npm may compile native addons (`better-sqlite3`, `tree-sitter`).
> If install fails, install build tools first.

## Requirements (native build tools)

- Node.js >= 18
- Python 3
- A C/C++ toolchain

### Ubuntu/Debian

```bash
sudo apt install python3 build-essential
```

### macOS

```bash
xcode-select --install
```

### Windows

Install Visual Studio Build Tools (C++), then run the install again.

## From source (development)

```bash
git clone https://github.com/Bytefield/neural-code-atlas.git
cd neural-code-atlas
npm install
npm run build
npm link          # makes `nca` available globally
```

## MCP Server

Run the MCP server (stdio JSON-RPC):

```bash
nca mcp
```
