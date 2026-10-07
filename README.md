# 🏴‍☠️

My vibecoding re-styling tools. Runs linters/tests and builds a review prompt for whatever AI agent is in the captain's chair. Pirate style.

## Install

Requires [bun](https://bun.sh).

```bash
ln -sf "$(pwd)/rrr.ts" ~/.local/bin/rrr
```

## Usage

```
rrr                    review uncommitted changes (default): tracked diff vs HEAD plus untracked files
rrr staged             review staged changes
rrr last               review last commit
rrr --last <N>         review last N commits
rrr --since <dur>      review changes in last duration (e.g. 1d, 10h, 30m)
rrr --branch <name>    review diff vs branch
rrr <path>             review a file, dir, or glob
rrr project            review whole project (no diff)

  -p, --python         python lens (ruff, ty/mypy, pre-commit, pytest, typing guidance)
  -r, --rust           rust lens (cargo fmt/clippy/test, rust guidance)
  -o, --ocaml          ocaml lens (dune build, ocamlformat, ocaml guidance)
  -t, --typescript     typescript lens (tsc, eslint, biome, ts guidance; react guidance for .tsx changes or react projects)
  -S, --no-style       skip language-specific style guidance
  -h, --help           show this help
```

`rrr -p` with nothing uncommitted runs the aggressive Python style review
(`prompts/python-style.md`) over every `.py` file git knows about (tracked or untracked-but-not-ignored) instead (unless `-S` is given).

## What it runs

The language is auto-detected from the extensions of the changed files (or from
the project structure for `project`), or forced with a flag. Each language adds
its own guidance to the prompt and runs the project's tooling:

- **Python**: `pre-commit run --all-files` when `.pre-commit-config.yaml` exists, then
  `ruff check` + `ruff format --check`, `ty` and/or `mypy` (whichever `pyproject.toml`
  configures) unless the pre-commit config already runs them, and `pytest tests` when a
  `tests/` directory exists. Tools run through `uv run --locked` when there is a `uv.lock`,
  otherwise directly from `.venv/bin`.
- **Rust**: `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, and
  `cargo test` per `Cargo.toml` root, with `--locked` when a `Cargo.lock` exists.
- **OCaml**: `dune build @check`, `ocamlformat --check` when `.ocamlformat` exists,
  `dune runtest`, per `dune-project` root.
- **TypeScript**: `tsc --noEmit`, `eslint .`, `biome check` when configured and
  installed in `node_modules`. React guidance is added for `.tsx`/`.jsx` changes or
  when `react` is a `package.json` dependency.

A configured tool that is missing is reported as NOT RUN rather than failing the review.

## Smoke test

```bash
./smoke.sh
```

Builds a throwaway repo and checks exit codes and prompt contents for every target.

## Output

The review prompt goes to stdout. Progress goes to stderr.

Exit codes: `0` = prompt ready, `2` = nothing to review, `1` = error.

## Skills

```bash
./symlink-all.sh
```

Links `.claude/skills/rrr` and `.claude/skills/rrr-auto` into the skill directories
for Claude Code, pi-mono, and codex. opencode reads `~/.claude/skills/` automatically.

**`/rrr`** — manual invocation, always available in any session.

**`rrr-auto`** — invisible to you, Claude-only. Tells Claude to invoke `/rrr` proactively
after meaningful coding tasks — but only in projects that have opted in.

### Opting in

Drop a `.rrr` file or directory in the project root:

```bash
touch .rrr   # or: mkdir .rrr
```
