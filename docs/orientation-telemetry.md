# Orientation telemetry — install & usage

> Local, opt-in telemetry that measures the **baseline cost of orientation** in
> real Claude Code sessions before any "recent intent" feature is built. Nothing
> leaves the machine. See [the event schema](./schema/orientation-events.md) for
> the on-disk contract.

This is **measurement only** — it does not change how Claude works, does not
modify the brief, and does not read session transcripts. It records three event
types (`session_start`, `user_prompt_submit`, `post_tool_use`) to an append-only
log and lets you summarize the floor: how much searching/reading happens before
the first edit, and how much that varies across sessions.

## What is captured

| Event | Captured | Never captured |
|---|---|---|
| `session_start` | matcher (startup/resume/clear/compact), branch | — |
| `user_prompt_submit` | sha256-truncated `prompt_hash` + length | the raw prompt text |
| `post_tool_use` | tool name, file path, duration, outcome | the raw tool input / command |

All fields are redacted before they touch disk (PEM, JWT, AWS/GitHub/Stripe/OpenAI
keys, sensitive env assignments). Events live in
`.nca/metrics/orientation-events.jsonl`, which is gitignored. Retention is 30 days.

## Install (in the repo you want to measure — e.g. SYNIO, *not* nca)

Build NCA once (`npm run build` in the nca repo), then add the three hooks to the
**target repo's** `.claude/settings.json`, pointing at the compiled hooks
(use the absolute path to your nca checkout):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/to/nca/dist/hooks/session-start.js" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/to/nca/dist/hooks/user-prompt-submit.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/to/nca/dist/hooks/post-tool-use.js" }] }
    ]
  }
}
```

Installing the hooks *is* the opt-in: with no hooks configured, nothing is
captured. The hooks are fail-open — a logging error never blocks or breaks the
session.

## Use

```bash
nca metrics orientation                       # per-session + cross-session summary
nca metrics orientation --json                # machine-readable
nca metrics orientation --purge --older-than 30   # prune events older than N days
```

The summary reports, per session, raw orientation tool-calls (Glob/Grep/LS/Find/
Read, unclassified), reads, the first-edit candidate, turns-to-first-edit and
reads-before-first-edit; and across sessions, the mean and **stddev** of the raw
orientation tool-call counts — the variance that tells you whether an effect is
detectable at your sample size.

## Collecting a baseline

1. Install the hooks in a real working repo (SYNIO).
2. Work normally for ~10 sessions.
3. Run `nca metrics orientation --summary` and read the variance.

That variance decides whether a 25%-ish effect is detectable at n≈10 or whether
you need more sessions / normalization — *before* building the intent feature on
top. The next PR (post-baseline) adds read classification against blast-radius,
resolves "first *relevant* edit" against git, and only then the intent MVP.
