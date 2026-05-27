# Vault Operations

## `nca vault scan <root>`

Indexes an Obsidian Markdown vault into the NCA database.

### Usage

```bash
nca vault scan /path/to/vault
nca vault scan /path/to/vault --verbose
nca vault scan /path/to/vault --dry-run
```

### How It Works

1. Walks the directory tree starting at `<root>`, looking for `.md` files.
2. Excludes paths containing: `.obsidian/`, `.trash/`, `.smart-connections/`, `node_modules/`, `.git/`
3. If `.claudeignore` exists in the vault root, reads glob patterns and excludes matching files.
4. For each `.md` file, parses frontmatter (YAML header) and body using `parseNote()`.
5. Computes SHA256 hash of the body content.
6. Chunks body into ~1000-character segments with paragraph-level overlap.
7. Inserts or updates database records:
   - **First scan:** `indexed++` for each new note
   - **Unchanged hash:** `unchanged++` (no database change)
   - **Changed hash:** `updated++`, deletes old chunks, inserts new ones
8. All database writes execute in a single transaction (atomic).
9. Errors during parsing are logged to stderr and counted; scanning continues.

### Output

```
[OK] Vault scan completed in 18.4s
- Indexed:   3
- Updated:   1
- Unchanged: 5
- Errors:    0
```

### Options

- `--verbose` — Print one line per file as it's processed.
- `--dry-run` — Compute result but do not write to database.

### Database Schema

Vault notes are stored in the `notes` and `note_chunks` tables:

```sql
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  path         TEXT UNIQUE NOT NULL,
  type         TEXT,
  status       TEXT DEFAULT 'vigente',  -- 'vigente', 'borrador', 'obsoleto'
  area         TEXT,
  summary      TEXT,
  updated      TEXT,
  content_hash TEXT NOT NULL,           -- SHA256 of body
  indexed_at   TEXT NOT NULL            -- ISO timestamp
);

CREATE TABLE note_chunks (
  note_id   TEXT NOT NULL REFERENCES notes(id),
  chunk_idx INTEGER NOT NULL,
  text      TEXT NOT NULL,
  PRIMARY KEY (note_id, chunk_idx)
);
```

### Frontmatter Fields

Notes can include a YAML frontmatter block at the top:

```markdown
---
id: my-note-id
type: refactor
status: vigente
area: architecture
summary: Summary of the note
updated: 2024-12-25T10:30:00Z
---

Body text here...
```

If `id` is not provided, it is derived from the filename (lowercase, hyphens for spaces/special chars).

### `.claudeignore`

Create a `.claudeignore` file in the vault root to exclude files by glob pattern:

```
# .claudeignore
archived/**
drafts/*.md
_*.md
```

Each line is a glob pattern (using minimatch syntax). Comments start with `#`.

### Future Phases

- **Fase 1:** MCP tools for real-time vault access from Claude.
- **Fase 2:** Bi-directional relations between notes (backlinks, cross-references).
- **Fase 3:** Semantic search over note content via FTS5 index.
