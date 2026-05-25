# NCA MCP Server Setup for Claude Code

## Status
✅ NCA built and linked globally
✅ SYNIO indexed: 10,396 nodes, 2,837 files, 719 flows
✅ MercadoHipotecas indexed: 3,234 nodes, 864 files, 433 flows

## Configuration for Claude Code (Windows)

### 1. Locate Claude Code settings file

Typical locations:
- `%USERPROFILE%\.claude\settings.json`
- `%APPDATA%\.claude\settings.json`
- `%LOCALAPPDATA%\claude\settings.json`

If it doesn't exist, create it.

### 2. Add NCA MCP server entry

**For SYNIO:**
```json
{
  "mcpServers": {
    "nca-synio": {
      "command": "node",
      "args": ["C:\\dev\\nca\\dist\\cli.js", "mcp"],
      "env": {
        "NCA_DB_PATH": "C:\\dev\\synio\\.nca\\nca.db"
      }
    }
  }
}
```

**For MercadoHipotecas:**
```json
{
  "mcpServers": {
    "nca-synio": {
      "command": "node",
      "args": ["C:\\dev\\nca\\dist\\cli.js", "mcp"],
      "env": {
        "NCA_DB_PATH": "C:\\dev\\synio\\.nca\\nca.db"
      }
    },
    "nca-mercado": {
      "command": "node",
      "args": ["C:\\dev\\nca\\dist\\cli.js", "mcp"],
      "env": {
        "NCA_DB_PATH": "C:\\dev\\webs\\mercado-hipotecas\\.nca\\nca.db"
      }
    }
  }
}
```

### 3. Restart Claude Code

Close all Claude Code instances and reopen.

### 4. Verify MCP connection

In Claude Code terminal, you should see NCA tools available:
- `nca_query` - semantic search
- `nca_flow` - trace execution flow
- `nca_evolve` - architectural warnings
- `nca_status` - index stats

### 5. Test with a query

```
Ask Claude Code: "Using NCA, find the email queue worker implementation"
```

Expected: Should use `nca_query` tool and return processEmail function location.

---

## Known Issues

### Better-SQLite3 Native Binary
If you see `invalid ELF header` error in WSL/Docker:
```bash
cd /dev-projects/nca
npm rebuild better-sqlite3
```

### MCP Server Not Found
If Claude Code can't find the MCP server, verify:
1. Node.js is in PATH
2. `C:\dev\nca\dist\cli.js` exists
3. Settings.json is in the correct location
4. Claude Code was restarted after config change

---

## Next: NCA Enhancements Scope

Ready to receive scope for:
- Better output formatting (current is too verbose)
- Additional commands/features
- Integration improvements
