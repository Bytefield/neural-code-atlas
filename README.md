# Neural Code Atlas (NCA)

> Measures how AI coding agents actually behave in your codebase and turns that into
> decisions you can defend — including the decision to build nothing. Underneath it: a
> local structural index of your code (tree-sitter + SQLite), exposed via CLI and MCP.

Local-first. No cloud, no embeddings, no LLM calls. Everything runs on your machine and
stays there.

## What it does today

Two layers, one CLI.

### 1. Behavioural instrument — `nca corpus` *(new in 1.6)*

Reads your Claude Code session logs and keeps only their *shape*: file paths, tool names,
timestamps, session ids, counts. Never prompts, never code, never tool output. From that it
answers, with frozen heuristics and no LLM:

- Where does the agent repeatedly orient? What does it reread across sessions?
- What kind of work consumes orientation — implementation, diagnosis, search, shell?
- Which tools are actually in use, and are they helping? (NCA's own `nca_ask` included.)
- What should change — and what should **not** be built?

Each answer is a recommendation object (`dont_build` / `do` / `fix` / `no_intervention` /
`insufficient_evidence`) with its evidence, its rule and threshold, a categorical confidence
(`EVIDENCE_STRONG` … `INSUFFICIENT`, never a percentage), and the metric to remeasure.
Markdown is just the renderer.

```bash
nca corpus extract --project myapp --project-root /path/to/myapp --phase baseline --dry-run
nca corpus extract --project myapp --project-root /path/to/myapp --phase baseline
nca corpus orientation --project myapp --phase baseline
nca corpus insights --project myapp
# → ~/.nca/metrics/myapp/insights/   (never inside your repo)
```

On the one real corpus it has been validated against (93 sessions), it reproduced three
decisions that had previously taken hours of manual analysis — two "don't build this" and
one "fix this first" — purely from the events. That is the whole claim so far. Whether it
generalizes to codebases and people it has never seen is the next test, not a done deal.

### 2. Structural index — `nca scan` and friends

A persistent SQLite graph of functions, arrows, methods and classes plus your Markdown docs,
with graph analytics computed on every scan (Louvain communities, PageRank, betweenness,
god nodes).

```bash
nca scan .                     # build/update the index; writes .nca/SKILL.md
nca ask handleRequest          # exact-name lookup; module, PageRank rank, god-node flag
nca flow handleRequest         # execution path from an entry point
nca impact                     # callers, docs, security and silent-fallback risk per changed symbol
nca evolve                     # architectural warnings: complexity, cycles, deep chains, god nodes
```

`nca_ask` is **exact-name retrieval** over indexed nodes. It is not semantic search and does
not answer natural-language questions; on no match it says so explicitly and returns no
graph content. `nca impact` is the more useful entry point for "what does this change touch".

## Where it is going

NCA's roadmap is gated on evidence, not dates. Each step only starts once the previous one
has produced measurable results:

1. **Decision ledger** — every recommendation → decision → outcome, so confidence can be
   calibrated against what actually happened.
2. **Treatment loop** — before/after measurement of an intervention (e.g. a context change)
   on the same codebase, per lane, with effect sizes and *n*. Quasi-experiment, not A/B, and
   labelled as such.
3. **Generalization** — other repos, then a corpus from someone who isn't the author. This is
   the test of whether NCA discovers knowledge or reconstructs one person's habits.
4. **Machine-readable judgment** — recommendation objects via `--format json`; proposed
   context changes as diffs a human accepts. NCA never edits your files on its own.
5. **Advisory preflight** — before a task, what to read first, what it touches, what prior
   evidence says. Read-only. Must be able to answer *no policy applies*.

Anything beyond that — agents specialised per task class, orchestration — is explicitly not
scheduled. If the evidence never justifies it, it never gets built.

## Install

```bash
npm i -g @synio-es/neural-code-atlas
nca --help
```

Native modules (`better-sqlite3`, `tree-sitter`) need build tools; see `INSTALL.md`.

## Commands

**Corpus** — `nca corpus extract` (`--project`, `--project-root`, `--phase baseline|treatment`,
`--since`, `--until`, `--dry-run`, `--include-worktrees`, `--min-events`) ·
`nca corpus orientation` (`--project`, `--phase`, `--json`, `--csv`, `--include-no-write`) ·
`nca corpus insights` (`--project`).

**Code** — `nca ask <query…>` · `nca flow <name>` · `nca impact [diff-spec]` (`--json`, `--air`,
`--out`) · `nca evolve`.

**Docs & vault** — `nca vault scan <path>` · `nca vault search <query>` · `nca vault get <id|path>` ·
`nca related <symbol|doc>` · `nca docs audit`.

**Context** — `nca task [description]` (`--show`, `--clear`) · `nca brief [--light]`.

**Index** — `nca scan [path]` · `nca status` · `nca watch [path]` · `nca insights` ·
`nca projects` · `nca migrate`.

**Server** — `nca mcp`.

`nca <command> --help` for full options.

## MCP server (Claude Code)

```json
{ "mcpServers": { "nca": { "command": "nca", "args": ["mcp"] } } }
```

Tools: `nca_ask`, `nca_flow`, `nca_status`, `nca_evolve`, `nca_insights`, `nca_projects`.
The project is autodetected from the working directory; pass `project` to target another.

The MCP server is a long-lived process. After rebuilding or upgrading NCA, restart the
connection — a stale server against a migrated database reports
`NCA schema version mismatch: db_version=… build_version=… db_path=…` with the fix.

## Graph analytics

Computed on every scan, stored in the index, surfaced in `nca ask` and `SKILL.md`:
**Louvain communities** (which files form natural modules), **PageRank** (load-bearing
nodes), **betweenness** (bottlenecks everything routes through), **god nodes** (coupling
above the p95 of the graph).

`SKILL.md` — written to `.nca/` on every scan — is a token-efficient map: modules with node
counts, top nodes by PageRank, god nodes, cycle and deep-chain counts, indexed docs. Safe to
commit; it contains only structural metadata.

## Configuration

`.nca/config.json` in the project root:

```json
{
  "exclude": ["generated", "vendor"],
  "include_extensions": [".ts", ".js", ".py"],
  "max_file_size_kb": 256,
  "evolve": { "complexityThreshold": 10, "maxParamsThreshold": 7, "maxDepsThreshold": 15, "maxChainDepth": 6 }
}
```

Languages: TypeScript (`.ts`, `.tsx`), JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`), Python.

## Keeping the index current

`nca scan` is deliberate, not automatic. First time on a repo, after large refactors or
import changes, or when `nca status` shows an old scan: rescan. Small edits: not needed.
Long sessions: `nca watch`. Optional post-commit hook in `.git-hooks/`.

## Privacy

`nca corpus extract` runs on your machine and writes derived events only. The file it
produces contains paths, tool names, timestamps, session ids, counts and, for `nca_ask` calls,
a result label (`hit` / `clean_no_match` / `noisy_fallback` / `error`) computed at extraction.
The raw transcript text is read once and never persisted. Open the output and read it before
sharing it with anyone.

Claude Code deletes transcripts after ~30 days by default. Derived evidence that cannot be
recomputed after that is extracted first and kept as the canonical record.

## Known limitations

- `nca_ask` is exact-name only; its earlier description over-promised ("function name,
  concept, module…"). Recorded, not yet changed.
- Six unusually large files crash the native tree-sitter binding (a size ceiling, not an
  encoding issue) and are absent from the index.
- The insights engine has been validated on one corpus. Cross-user validation is pending.
- One test (`VAULT-04`) fails on native Windows only (path separator). Windows is a
  first-class target; this is tracked debt.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Highlights:

- **1.6.0** — `nca corpus insights`, `orientation_event_v3`, `nca impact`, `.tsx` grammar fix,
  clean `nca_ask` no-match, structured schema-skew error, frozen replay fixture.
- **1.5.0** — vault search/get, `nca related`, `nca docs audit`, `nca task` / `nca brief`.
- **1.3.0** — unified code + docs indexing.
- **1.2.0** — graph analytics, `SKILL.md`.

## License

MIT
