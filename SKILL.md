# NCA — Before grep, ask NCA

When exploring this codebase, use NCA commands for efficient navigation. It's faster and more accurate than manual grepping.

## NCA first — navigation reflexes

BEFORE cat, grep, find, or read_file on this repo:

```bash
nca ask "<symbol>"          find definitions and callers
nca vault search "<topic>"  find docs and decisions [--root <vault>]
nca flow "<function>"       trace execution paths
nca related "<symbol>"      find docs linked to a code symbol
nca docs audit              see what needs documenting
```

**Anti-pattern:** `grep` or `cat` without `nca ask` first.

**Exception:** Dynamic imports, type-only imports, initial orientation before NCA is indexed.

## Quick workflow

```bash
# Before starting work
nca task "Implement new feature X"

# Understand a module
nca ask "handleRequest"

# See what changed and ripples of a change
nca flow "userAuthMiddleware"

# Check what docs are out of sync
nca docs audit

# Generate a focused brief for your task
nca brief --light

# After work, clear task state
nca task --clear
```
