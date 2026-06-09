# Orientation telemetry — event schema

> `schema_version: 1`. Source of truth for the events written to
> `.nca/metrics/orientation-events.jsonl`. The TypeScript types live in
> [`src/hooks/lib/events.ts`](../../src/hooks/lib/events.ts) and MUST stay in sync with this doc.

This telemetry measures the **baseline cost of orientation** in real Claude Code
sessions — how much an agent searches/reads before it makes its first edit, and
how that varies across sessions — *before* any "recent intent" feature is built.
It is local-first, opt-in, and measures the floor; it is not the feature itself.

## Storage

- **File:** `.nca/metrics/orientation-events.jsonl`, one JSON object per line, **append-only**.
- **Gitignored:** `.nca/metrics/` is covered by `.gitignore` (the whole `.nca/` tree is ignored).
- **Retention:** events older than 30 days are pruned. Manual prune:
  `nca metrics orientation --purge --older-than <days>`.

## Event types (exactly three)

This schema version defines **exactly three** event types. `session_end` is
**deliberately out of scope** — a robust end-of-session aggregate depends on the
full capture chain (PreCompact + PostCompact + SessionEnd best-effort) described
in the vault integration spec; capturing it half-way here would only yield an
incomplete baseline. **Do not add a fourth event type in this PR** — if the need
appears during implementation, stop and ask first.

| `event_type` | Hook | When |
|---|---|---|
| `session_start` | SessionStart | session begins (startup / resume / clear / compact) |
| `user_prompt_submit` | UserPromptSubmit | each user turn submitted |
| `post_tool_use` | PostToolUse (matcher `*`) | after every tool call |

### Common envelope (all events)

| field | type | notes |
|---|---|---|
| `event_type` | `"session_start" \| "user_prompt_submit" \| "post_tool_use"` | discriminant |
| `session_id` | `string` | from the hook host |
| `timestamp` | `string` | ISO 8601, UTC |
| `repo_id` | `string` | `basename(cwd)` |
| `cwd` | `string` | absolute working directory |
| `git_branch` | `string \| null` | `null` when `cwd` is not a git repo |
| `schema_version` | `number` | `1` for events written by this code |
| `payload` | object | shape determined by `event_type` (below) |

### `session_start` → `payload`

| field | type | notes |
|---|---|---|
| `matcher` | `"startup" \| "resume" \| "clear" \| "compact"` | which SessionStart matcher fired |

### `user_prompt_submit` → `payload`

| field | type | notes |
|---|---|---|
| `prompt_hash` | `string` | sha256 of the original prompt, **first 16 hex chars** |
| `prompt_length` | `number` | character length of the original prompt |

> **`prompt_hash` is not anonymization.** It is a sha256 truncated to 16 chars,
> used to correlate events within the same session without storing the text. In
> a small or known prompt space the hash is a correlatable identifier, **not**
> cryptographic anonymization. For local baseline research in SYNIO this is
> acceptable. **If this telemetry ever leaves the author's local environment, revisit this.**

### `post_tool_use` → `payload`

| field | type | notes |
|---|---|---|
| `tool_name` | `string` | e.g. `Read`, `Grep`, `Edit` |
| `file_path` | `string \| null` | normalized path when the tool acts on a file, else `null` |
| `duration_ms` | `number \| null` | when the host provides it, else `null` |
| `outcome` | `"ok" \| "error" \| null` | tool outcome when known |

## Privacy & robustness contract

- **No raw prompts, no raw tool input** are ever written. Only `prompt_hash` + `prompt_length`.
- **Redaction:** every event passes through `redact()` (`src/hooks/lib/redact.ts`)
  before serialization — recursive over all payload strings, plus a second
  defense-in-depth pass over the final serialized line. Denylist covers `.env`
  assignments, API keys, tokens (`ghp_`, `sk_live_`, `sk-…`), AWS keys (`AKIA…`),
  JWTs (`eyJ…`), and PEM blocks.
- **Fail-open:** capture hooks have a short hard timeout and **always exit 0**. A
  logging failure must never block or break the Claude Code session.
- **Concurrency:** writes are append-only with an `mkdir` mutex; rotation is best-effort.

## Read path

`nca metrics orientation --summary` reports, per session and as cross-session
aggregates: raw orientation tool-calls (Glob/Grep/LS/Find/Read, unclassified),
all reads with their `file_path` (unclassified against blast-radius), turns to
first-edit candidate (unresolved against git), and the **variance (stddev)** of
the raw orientation-tool-call counts across sessions.

## Explicitly out of scope (this PR)

- `session_end` aggregate (see above).
- Classifying reads as orientation / non-orientation, or against blast-radius.
- Resolving "first *relevant* edit" against git.
- Reading `~/.claude/projects/{slug}/*.jsonl`, and any change to `brief.ts`.
