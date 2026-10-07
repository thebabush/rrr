#!/usr/bin/env bash
# Smoke test for rrr: builds a throwaway repo and checks exit codes and prompt
# contents for every target. Needs bash, git and bun. Stub executables exercise
# tool coverage without installing linters in the fixture.

set -euo pipefail

RRR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rrr.ts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
out=""
code=0

# run <expected-exit> <args...>: runs rrr in the current dir, captures stdout+stderr.
run() {
	local want="$1"; shift
	set +e
	out="$("$RRR" "$@" 2>&1)"
	code=$?
	set -e
	if [ "$code" != "$want" ]; then
		echo "FAIL: rrr $* exited $code, wanted $want"; echo "$out" | head -5; fail=1
	fi
}

expect() {
	if ! grep -qF -- "$1" <<<"$out"; then echo "FAIL: output missing: $1"; fail=1; fi
}

reject() {
	if grep -qF -- "$1" <<<"$out"; then echo "FAIL: output must not contain: $1"; fail=1; fi
}

# ── fixture ────────────────────────────────────────────────────────────────
cd "$WORK"
run 1; expect "not a git repository"

git init -q . && git config user.email t@t && git config user.name t
run 2; expect "Nothing to review"
printf 'x = 1\n' > initial.py
run 0; expect "initial.py"; expect "Untracked files:"
run 0 -p; expect "Review uncommitted changes"
git add initial.py
run 0; expect "initial.py"
run 0 staged; expect "initial.py"
run 0 -p; expect "Review uncommitted changes"
git rm -q --cached initial.py && rm initial.py
cat > pyproject.toml <<'TOML'
[project]
name = "demo"
[dependency-groups]
dev = ["ruff", "ty"]
[tool.ty.rules]
TOML
printf 'def f(x: int) -> int:\n    return x\n' > demo.py
printf '{"name":"demo","dependencies":{"react":"^19"}}\n' > package.json
printf 'export const App = () => null;\n' > App.tsx
git add -A && git commit -qm init
run 0 last; expect "Review the last commit"; expect "demo.py"
run 0 --last 1; expect "demo.py"
printf 'export const Two = 2;\n' > two.ts
git add -A && git commit -qm second

# ── targets ────────────────────────────────────────────────────────────────
run 0 -h;            expect "Usage: rrr"
run 2;               expect "Nothing to review (uncommitted changes is empty)"
run 2 staged;        expect "Nothing to review (staged changes is empty)"
run 0 last;          expect "Review the last commit"; expect "two.ts"; expect "assertNever"; reject "cn()"
run 0 --last 2;      expect "demo.py"; expect "two.ts"
run 1 --last 5;      expect "git diff failed"
run 1 --branch nope; expect "git diff failed"
run 0 --since 52w;   expect "changes in the last 52w"; expect "demo.py"
run 1 nope;          expect "Unknown argument"
run 0 .;             expect "Review . in this repo"; expect "App.tsx"
run 1 prompts;       expect "Unknown argument"

# project mode: tooling detected, nothing installed → NOT RUN, react guidance on
run 0 project
expect "Review the overall project structure"
expect ".venv/bin/ruff check . (NOT RUN)"
expect ".venv/bin/ty check (NOT RUN)"
reject ".venv/bin/mypy"
reject "assertNever"  # no tsconfig, so no TS lens in project mode
expect "Tools marked NOT RUN"

# forced TS lens: react guidance comes from package.json
run 0 -t project;    expect "assertNever"; expect "cn()"

# Configured TypeScript tools must be reported even without node_modules.
printf '{}\n' > tsconfig.json
printf 'export default [];\n' > eslint.config.js
printf '{}\n' > biome.jsonc
run 0 project
expect "./node_modules/.bin/tsc --noEmit (NOT RUN)"
expect "./node_modules/.bin/eslint . (NOT RUN)"
expect "./node_modules/.bin/biome check (NOT RUN)"
expect "assertNever"
run 0 -t project; expect "./node_modules/.bin/tsc --noEmit (NOT RUN)"
rm tsconfig.json eslint.config.js biome.jsonc

# uncommitted: tracked edit + untracked file, python lens picked up from .py
printf '\n' >> App.tsx
printf 'x = 1\n' > new.py
run 0
expect "Review uncommitted changes"
expect "App.tsx"
expect "Untracked files:"
expect "new.py"
expect "Prefer dataclasses"
if perl -0ne 'exit 1 if /```\n```/' <<<"$out"; then :; else echo "FAIL: nested code fences"; fail=1; fi
git checkout -q App.tsx && rm new.py

# staged-only change shows up in the default target too
printf '\n' >> two.ts && git add two.ts
run 0;               expect "two.ts"
run 0 staged;        expect "Review staged changes"
git reset -q && git checkout -q two.ts

# -S drops language guidance, -p on a clean tree runs the Python style review
run 0 -S last;       reject "assertNever"
run 0 -p;            expect "aggressive Python style reviewer"; expect "demo.py"

# Ruff linting and formatting are independent pre-commit hooks.
mkdir -p .venv/bin
printf '#!/bin/sh\nexit 0\n' > .venv/bin/pre-commit
printf '#!/bin/sh\necho STANDALONE_RUFF "$@"\n' > .venv/bin/ruff
chmod +x .venv/bin/pre-commit .venv/bin/ruff
cat > .pre-commit-config.yaml <<'YAML'
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.1.0
    hooks:
      - id: ruff-format
YAML
run 0 -p project
expect "STANDALONE_RUFF check ."
reject "STANDALONE_RUFF format"
sed 's/id: ruff-format/id: ruff-check/' .pre-commit-config.yaml > hooks.tmp
mv hooks.tmp .pre-commit-config.yaml
run 0 -p project
reject "STANDALONE_RUFF check"
expect "STANDALONE_RUFF format --check ."

# Unavailable or failing pre-commit cannot suppress the standalone checks.
rm .venv/bin/pre-commit
run 0 -p project
expect "pre-commit run --all-files (NOT RUN)"
expect "STANDALONE_RUFF check ."
expect "STANDALONE_RUFF format --check ."
printf '#!/bin/sh\nexit 1\n' > .venv/bin/pre-commit
chmod +x .venv/bin/pre-commit
run 0 -p project
expect "pre-commit run --all-files (FAILED"
expect "STANDALONE_RUFF check ."

# Exercise installation in isolated destinations without touching user skills.
INSTALL_ROOT="$WORK/install"
export INSTALL_ROOT
sed 's|"$HOME/|"$INSTALL_ROOT/|g' "$(dirname "$RRR")/symlink-all.sh" > "$WORK/install-skills.sh"
mkdir -p "$WORK/.claude/skills/rrr" "$WORK/.claude/skills/rrr-auto"
mkdir -p "$INSTALL_ROOT/.claude/skills/rrr"
printf 'existing skill\n' > "$INSTALL_ROOT/.claude/skills/rrr/SKILL.md"
if out="$(bash "$WORK/install-skills.sh" 2>&1)"; then
	echo "FAIL: installer accepted an existing directory"; fail=1
fi
expect "Conflict:"
if [ -e "$INSTALL_ROOT/.claude/skills/rrr/rrr" ] || [ -L "$INSTALL_ROOT/.claude/skills/rrr/rrr" ]; then
	echo "FAIL: installer created a nested symlink"; fail=1
fi
if [ "$(cat "$INSTALL_ROOT/.claude/skills/rrr/SKILL.md")" != "existing skill" ]; then
	echo "FAIL: installer modified the existing skill"; fail=1
fi
rm -r "$INSTALL_ROOT/.claude/skills/rrr"
out="$(bash "$WORK/install-skills.sh" 2>&1)"; expect "(linked)"
out="$(bash "$WORK/install-skills.sh" 2>&1)"; expect "(exists)"; reject "(linked)"

if [ "$fail" = 0 ]; then echo "smoke: all checks passed"; else echo "smoke: FAILED"; exit 1; fi
