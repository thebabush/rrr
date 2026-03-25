# 🏴‍☠️

My vibecoding re-styling tools. Runs linters/tests and builds a review prompt for whatever AI agent is in the captain's chair. Pirate style.

## Install

```bash
ln -sf "$(pwd)/rrr.ts" ~/.local/bin/rrr
```

## Usage

```
rrr              # review uncommitted changes (default)
rrr last         # review the previous commit
rrr project      # review overall project structure
rrr python       # aggressive Python style & typing review
```

Output goes to stdout (the review prompt). Progress goes to stderr.

Exit codes: `0` = prompt ready, `2` = nothing to review, `1` = error.

## Skills

```bash
./symlink-all.sh
```

Links the skills for Claude Code, pi-mono, codex, and opencode.

**`/rrr`** — manual invocation, always available in any session.

**`rrr-auto`** — invisible to you, Claude-only. Tells Claude to invoke `/rrr` proactively
after meaningful coding tasks — but only in projects that have opted in.

### Opting in

Drop a `.rrr` file or directory in the project root:

```bash
touch .rrr   # or: mkdir .rrr
```
