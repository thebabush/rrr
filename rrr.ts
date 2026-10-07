#!/usr/bin/env bun
/**
 * rrr — review review review
 *
 * Runs linters/tests and builds a review prompt for your AI coding agent.
 *
 * Usage:
 *   rrr                    review uncommitted changes (default)
 *   rrr staged             review staged changes
 *   rrr last               review last commit
 *   rrr --last <N>         review last N commits
 *   rrr --since <dur>      review changes in last duration (e.g. 1d, 10h, 30m)
 *   rrr --branch <name>    review diff vs branch
 *   rrr path               review a file, dir, or glob
 *   rrr project            review whole project (no diff)
 *
 *   -p / --python          python lens (ruff, ty/mypy, pre-commit, pytest, typing guidance)
 *   -r / --rust            rust lens (cargo fmt/clippy/test, rust guidance)
 *   -o / --ocaml           ocaml lens (dune build, ocamlformat, ocaml guidance)
 *   -t / --typescript      typescript lens (tsc, eslint, biome, ts guidance; react guidance for .tsx changes or react projects)
 *   -S / --no-style        skip language-specific style guidance
 *
 * Exit codes:
 *   0  prompt written to stdout
 *   2  nothing to review
 *   1  error
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, extname } from "node:path";

const PROMPTS = join(dirname(realpathSync(process.argv[1])), "prompts");
const prompt = (name: string) => readFileSync(join(PROMPTS, name), "utf8").trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Target =
	| { kind: "uncommitted" }
	| { kind: "staged" }
	| { kind: "project" }
	| { kind: "last"; n: number }
	| { kind: "since"; dur: string }
	| { kind: "branch"; name: string }
	| { kind: "path"; glob: string };

interface Args {
	target: Target;
	python: boolean;
	rust: boolean;
	ocaml: boolean;
	typescript: boolean;
	noStyle: boolean;
}

interface Langs {
	python: boolean;
	rust: boolean;
	ocaml: boolean;
	typescript: boolean;
	react: boolean; // only meaningful when typescript is true
}

interface Tooling {
	// runner is the command prefix for project Python tools: `uv run --locked`
	// for a uv-managed project, empty to call .venv/bin/<tool> directly.
	python: { ruff: boolean; mypy: boolean; ty: boolean; runner: string[] };
	preCommit: boolean;
	preCommitHooks: { ruff: boolean; mypy: boolean; ty: boolean }; // all false without a config
	pytest: boolean;
	cargoRoots: string[];
	duneRoots: string[];
	ts: { tsc: boolean; eslint: boolean; biome: boolean };
	react: boolean;
}

interface Checks {
	linters: string[];
	tests: string[];
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const USAGE = `\
Usage: rrr [target] [options]

Targets:
  (none)             review uncommitted changes (default)
  staged             review staged changes
  last               review last commit
  --last <N>         review last N commits
  --since <dur>      review changes in last duration (e.g. 1d, 10h, 30m)
  --branch <name>    review diff vs branch
  path               review a file, dir, or glob
  project            review whole project (no diff)

Options:
  -p, --python       python lens (ruff, ty/mypy, pre-commit, pytest, typing guidance)
  -r, --rust         rust lens (cargo fmt/clippy/test, rust guidance)
  -o, --ocaml        ocaml lens (dune build, ocamlformat, ocaml guidance)
  -t, --typescript   typescript lens (tsc, eslint, biome, ts guidance; react guidance for .tsx changes or react projects)
  -S, --no-style     skip language-specific style guidance
  -h, --help         show this help
`;

function parseArgs(argv: string[]): Args {
	const args: Args = { target: { kind: "uncommitted" }, python: false, rust: false, ocaml: false, typescript: false, noStyle: false };
	const rest = argv.slice(2);
	let i = 0;

	while (i < rest.length) {
		const a = rest[i];

		if (a === "-h" || a === "--help") { process.stdout.write(USAGE); process.exit(0); }
		if (a === "-p" || a === "--python")     { args.python     = true; i++; continue; }
		if (a === "-r" || a === "--rust")       { args.rust       = true; i++; continue; }
		if (a === "-o" || a === "--ocaml")      { args.ocaml      = true; i++; continue; }
		if (a === "-t" || a === "--typescript") { args.typescript = true; i++; continue; }
		if (a === "--no-style" || a === "-S")   { args.noStyle    = true; i++; continue; }

		if (a === "last") {
			args.target = { kind: "last", n: 1 };
			i++; continue;
		}

		if (a === "--last") {
			const val = rest[++i];
			if (!val || !/^\d+$/.test(val)) die("--last requires a number, e.g. --last 3");
			args.target = { kind: "last", n: Number(val) };
			i++; continue;
		}

		if (a === "--since") {
			const val = rest[++i];
			if (!val || !/^\d+[mhdw]$/.test(val)) die(`--since requires a duration like 1d, 10h, 30m`);
			args.target = { kind: "since", dur: val };
			i++; continue;
		}

		if (a === "--branch") {
			const val = rest[++i];
			if (!val) die("--branch requires a branch name");
			args.target = { kind: "branch", name: val };
			i++; continue;
		}

		if (a === "staged")  { args.target = { kind: "staged" };  i++; continue; }
		if (a === "project") { args.target = { kind: "project" }; i++; continue; }

		if (a.startsWith("./") || a.startsWith("/") || a.includes("*") || existsSync(a)) {
			args.target = { kind: "path", glob: a };
			i++; continue;
		}

		die(`Unknown argument: ${a}`);
	}

	return args;
}

function die(msg: string): never {
	process.stderr.write(`rrr: ${msg}\n`);
	process.exit(1);
}

function assertNever(x: never): never {
	throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

// spawnSync never throws: a missing binary (ENOENT) or a timeout (ETIMEDOUT)
// comes back as r.error, so surface it instead of dropping it.
function exec(cmd: string, args: string[], cwd = process.cwd(), timeoutMs = 120_000) {
	const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8" });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1, error: r.error as NodeJS.ErrnoException | undefined };
}

// Runs git and dies on failure, so a bad ref or a missing repo is reported
// instead of being mistaken for an empty diff.
function git(args: string[], cwd = process.cwd()): string {
	const r = exec("git", args, cwd);
	if (r.error) die(`git ${args[0]} failed: ${r.error.message}`);
	if (r.code !== 0) die(`git ${args[0]} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
	return r.stdout;
}

// git's well-known empty tree object; base for diffing a root commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Lists tracked + untracked-but-not-ignored files, honoring .gitignore.
function gitLsFiles(cwd: string, ...patterns: string[]): string {
	return git(["ls-files", "-co", "--exclude-standard", ...patterns], cwd);
}

// Lists untracked-but-not-ignored files only.
function untrackedFiles(cwd: string): string {
	return git(["ls-files", "-o", "--exclude-standard"], cwd).trim();
}

// ---------------------------------------------------------------------------
// Tooling detection
// ---------------------------------------------------------------------------

function detectPython(cwd: string): Tooling["python"] {
	const runner = existsSync(join(cwd, "uv.lock")) ? ["uv", "run", "--locked"] : [];
	const pyproject = join(cwd, "pyproject.toml");
	if (!existsSync(pyproject)) return { ruff: false, mypy: false, ty: false, runner };
	const content = readFileSync(pyproject, "utf8");
	return {
		ruff: /\bruff\b/.test(content),
		mypy: /\bmypy\b/.test(content),
		// "ty" is too short for a bare word match: require a [tool.ty] table, a
		// quoted dependency spec, or a ty.toml next to pyproject.toml.
		ty: /\[tool\.ty\b|["']ty(?:[<>=!~\[ ;]|["'])/.test(content) || existsSync(join(cwd, "ty.toml")),
		runner,
	};
}

// Which of the Python linters the pre-commit config already runs, so they are
// not run a second time on their own. A hook line reads like
// `entry: uv run --locked ty check`, `id: ruff-check` or `repo: .../mypy`.
function detectPreCommitHooks(cwd: string): Tooling["preCommitHooks"] {
	const config = join(cwd, ".pre-commit-config.yaml");
	if (!existsSync(config)) return { ruff: false, mypy: false, ty: false };
	const content = readFileSync(config, "utf8");
	return {
		ruff: /\bruff\b/.test(content),
		mypy: /\bmypy\b/.test(content),
		ty:   /\bty\b/.test(content),
	};
}

// pytest is only run against tests/, so a project without that directory is
// not tested even if pytest is installed. Under uv the binary need not be in
// .venv/bin yet: a pyproject.toml dependency is enough for `uv run` to provide it.
function detectPytest(cwd: string, python: Tooling["python"]): boolean {
	if (!existsSync(join(cwd, "tests"))) return false;
	if (existsSync(join(cwd, ".venv/bin/pytest"))) return true;
	const pyproject = join(cwd, "pyproject.toml");
	return python.runner.length > 0 && existsSync(pyproject) && /\bpytest\b/.test(readFileSync(pyproject, "utf8"));
}

// Directories containing a project marker file (Cargo.toml, dune-project),
// excluding those nested inside another such directory.
function findRoots(cwd: string, marker: string): string[] {
	const dirs = gitLsFiles(cwd, `**/${marker}`, marker)
		.split("\n")
		.filter(Boolean)
		.map(f => dirname(f))
		.sort(); // parents before children

	const roots: string[] = [];
	for (const dir of dirs) {
		const nested = roots.some(r => r === "." || dir === r || dir.startsWith(r + "/"));
		if (!nested) roots.push(dir);
	}

	return roots.map(d => join(cwd, d));
}

function detectOcamlformat(root: string): boolean {
	return existsSync(join(root, ".ocamlformat"));
}

function detectTypeScript(cwd: string): { tsc: boolean; eslint: boolean; biome: boolean } {
	const tsc = existsSync(join(cwd, "tsconfig.json")) && existsSync(join(cwd, "node_modules/.bin/tsc"));
	const eslintConfigs = [
		"eslint.config.js", "eslint.config.ts", "eslint.config.mjs", "eslint.config.cjs",
		".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", ".eslintrc",
	];
	const eslint = existsSync(join(cwd, "node_modules/.bin/eslint")) &&
		eslintConfigs.some(f => existsSync(join(cwd, f)));
	const biome = existsSync(join(cwd, "biome.json")) && existsSync(join(cwd, "node_modules/.bin/biome"));
	return { tsc, eslint, biome };
}

// True if package.json lists react as a dependency of any kind. A missing or
// malformed package.json means false.
function detectReact(cwd: string): boolean {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return false;
	let pkg: unknown;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return false;
	}
	if (typeof pkg !== "object" || pkg === null) return false;
	const deps = pkg as Record<string, unknown>;
	return ["dependencies", "devDependencies", "peerDependencies"].some(k => {
		const d = deps[k];
		return typeof d === "object" && d !== null && "react" in d;
	});
}

function detectTooling(cwd: string): Tooling {
	const python = detectPython(cwd);
	return {
		python,
		preCommit:      existsSync(join(cwd, ".pre-commit-config.yaml")),
		preCommitHooks: detectPreCommitHooks(cwd),
		pytest:         detectPytest(cwd, python),
		cargoRoots: findRoots(cwd, "Cargo.toml"),
		duneRoots:  findRoots(cwd, "dune-project"),
		ts:         detectTypeScript(cwd),
		react:      detectReact(cwd),
	};
}

// Which languages to actually care about, given flags and optionally a set of
// changed file extensions to auto-detect from. `tooling` is consulted for
// project-wide detection, and for react when the lens is forced by a flag.
function resolveLangs(args: Args, tooling: () => Tooling, changedExts?: Set<string>): Langs {
	if (args.python || args.rust || args.ocaml || args.typescript) {
		return { python: args.python, rust: args.rust, ocaml: args.ocaml, typescript: args.typescript, react: tooling().react };
	}
	// auto-detect
	if (changedExts) {
		return {
			python:     changedExts.has(".py"),
			rust:       changedExts.has(".rs"),
			ocaml:      changedExts.has(".ml") || changedExts.has(".mli"),
			typescript: changedExts.has(".ts") || changedExts.has(".tsx"),
			react:      changedExts.has(".tsx") || changedExts.has(".jsx"),
		};
	}
	// project-wide: detect from project structure
	const { python: py, cargoRoots, duneRoots, ts, react } = tooling();
	return {
		python:     py.ruff || py.mypy || py.ty,
		rust:       cargoRoots.length > 0,
		ocaml:      duneRoots.length > 0,
		typescript: ts.tsc || ts.eslint || ts.biome,
		react,
	};
}

function extsFromFiles(nameOnly: string): Set<string> {
	const exts = new Set<string>();
	for (const file of nameOnly.split("\n").filter(Boolean)) {
		const ext = extname(file);
		if (ext) exts.add(ext);
	}
	return exts;
}

// ---------------------------------------------------------------------------
// Linter/test runner
// ---------------------------------------------------------------------------

const SLOW_TOOL_TIMEOUT_MS = 600_000;

function runTool(cmd: string, toolArgs: string[], cwd: string, timeoutMs = 120_000): string {
	const label = `${cmd} ${toolArgs.join(" ")}`;
	process.stderr.write(`  ${label}…\n`);
	const r = exec(cmd, toolArgs, cwd, timeoutMs);
	if (r.error) {
		const code = r.error.code;
		const why =
			code === "ENOENT"    ? `${cmd} not found; is it installed in this project?` :
			code === "ETIMEDOUT" ? `timed out after ${timeoutMs / 1000}s` :
			r.error.message;
		return `### ${label} (NOT RUN)\n\n\`\`\`\n${why}\n\`\`\``;
	}
	// uv itself ran fine but the requested tool is not in the project environment.
	if (cmd === "uv" && r.code !== 0 && /Failed to spawn/.test(r.stderr)) {
		return `### ${label} (NOT RUN)\n\n\`\`\`\n${r.stderr.trim()}\n\`\`\``;
	}
	const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
	return `### ${label} (${r.code === 0 ? "PASSED ✓" : "FAILED ✗"})\n\n\`\`\`\n${out || "(no output)"}\n\`\`\``;
}

// Command and args to run a project Python tool through the project's runner,
// e.g. `uv run --locked ruff check .` or `.venv/bin/ruff check .`.
function pyCmd(tooling: Tooling, tool: string, ...toolArgs: string[]): [string, string[]] {
	const [cmd, ...rest] = tooling.python.runner;
	return cmd === undefined ? [`.venv/bin/${tool}`, toolArgs] : [cmd, [...rest, tool, ...toolArgs]];
}

function runChecks(langs: Langs, tooling: () => Tooling): Checks {
	const cwd = process.cwd();
	const linters: string[] = [];
	const tests: string[] = [];

	if (langs.python) {
		const t = tooling();
		const hooks = t.preCommitHooks;
		// pre-commit runs its own hooks; only run the linters it does not cover.
		if (t.preCommit) {
			process.stderr.write("Running pre-commit…\n");
			linters.push(runTool(...pyCmd(t, "pre-commit", "run", "--all-files"), cwd, SLOW_TOOL_TIMEOUT_MS));
		}
		const ruff = t.python.ruff && !hooks.ruff;
		const ty   = t.python.ty   && !hooks.ty;
		const mypy = t.python.mypy && !hooks.mypy;
		if (ruff || mypy || ty) process.stderr.write("Running Python linters…\n");
		if (ruff) {
			linters.push(runTool(...pyCmd(t, "ruff", "check", "."), cwd));
			linters.push(runTool(...pyCmd(t, "ruff", "format", "--check", "."), cwd));
		}
		if (ty)   linters.push(runTool(...pyCmd(t, "ty", "check"), cwd));
		if (mypy) linters.push(runTool(...pyCmd(t, "mypy", "."), cwd));
		if (t.pytest) {
			process.stderr.write("Running pytest…\n");
			// Scoped to tests/: an unscoped run also collects from ignored checkouts.
			tests.push(runTool(...pyCmd(t, "pytest", "-x", "-q", "--tb=short", "tests"), cwd, SLOW_TOOL_TIMEOUT_MS));
		}
	}

	if (langs.rust) {
		const roots = tooling().cargoRoots;
		if (roots.length > 0) {
			const locked = (root: string) => existsSync(join(root, "Cargo.lock")) ? ["--locked"] : [];
			process.stderr.write("Running cargo fmt…\n");
			for (const root of roots) {
				linters.push(runTool("cargo", ["fmt", "--all", "--", "--check"], root));
			}
			process.stderr.write("Running cargo clippy…\n");
			for (const root of roots) {
				linters.push(runTool("cargo", ["clippy", ...locked(root), "--all-targets", "--", "-D", "warnings"], root, SLOW_TOOL_TIMEOUT_MS));
			}
			process.stderr.write("Running cargo test…\n");
			for (const root of roots) {
				tests.push(runTool("cargo", ["test", ...locked(root)], root, SLOW_TOOL_TIMEOUT_MS));
			}
		}
	}

	if (langs.ocaml) {
		const roots = tooling().duneRoots;
		if (roots.length > 0) {
			process.stderr.write("Running dune build @check…\n");
			for (const root of roots) {
				linters.push(runTool("dune", ["build", "@check"], root, SLOW_TOOL_TIMEOUT_MS));
				if (detectOcamlformat(root)) {
					const mlFiles = gitLsFiles(root, "*.ml", "*.mli")
						.trim().split("\n").filter(Boolean);
					if (mlFiles.length > 0) {
						linters.push(runTool("ocamlformat", ["--check", ...mlFiles], root));
					}
				}
			}
			process.stderr.write("Running dune runtest…\n");
			for (const root of roots) {
				tests.push(runTool("dune", ["runtest"], root, SLOW_TOOL_TIMEOUT_MS));
			}
		}
	}

	if (langs.typescript) {
		const { tsc, eslint, biome } = tooling().ts;
		if (tsc || eslint || biome) process.stderr.write("Running TypeScript checks…\n");
		if (tsc)    linters.push(runTool("./node_modules/.bin/tsc", ["--noEmit"], cwd, SLOW_TOOL_TIMEOUT_MS));
		if (eslint) linters.push(runTool("./node_modules/.bin/eslint", ["."], cwd));
		if (biome)  linters.push(runTool("./node_modules/.bin/biome", ["check"], cwd));
	}

	return { linters, tests };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function guidance(langs: Langs, noStyle = false): string {
	let g = "- Bugs, logic errors, or edge cases\n";
	g += "- Code quality issues (naming, structure, duplication)\n";
	g += "- Missing error handling\n";
	g += "- Lint or type-check failures: fix the code; do not weaken configuration, add broad ignores, or exclude files\n";
	if (!noStyle) {
		if (langs.python)     g += prompt("python-guidance.md") + "\n";
		if (langs.rust)       g += prompt("rust-guidance.md") + "\n";
		if (langs.ocaml)      g += prompt("ocaml-guidance.md") + "\n";
		if (langs.typescript) g += prompt("ts-guidance.md") + "\n";
		if (langs.typescript && langs.react) g += prompt("react-guidance.md") + "\n";
	}
	return g;
}

function appendChecks(p: string, checks: Checks): string {
	if (checks.linters.length) {
		p += "## Linter Results\n\n" + checks.linters.join("\n\n");
		p += "\n\nIf any linters failed, include their issues in your review and fix them. Tools marked NOT RUN could not be executed; mention that but do not treat it as a code problem.\n\n";
	}
	if (checks.tests.length) {
		p += "## Test Results\n\n" + checks.tests.join("\n\n");
		p += "\n\nIf any tests failed, include their failures in your review and fix them.\n\n";
	}
	return p;
}

function buildDiffPrompt(stat: string, untracked: string, target: string, langs: Langs, checks: Checks, noStyle: boolean): string {
	let p = `Review ${target} in this repo. Read the changed files directly to do the review. Focus on:\n`;
	p += guidance(langs, noStyle);
	p += `- Anything that should be fixed\n\n`;
	p = appendChecks(p, checks);
	p += "## Changed Files\n\n";
	if (stat) p += `\`\`\`\n${stat}\n\`\`\`\n\n`;
	if (untracked) p += `Untracked files:\n\`\`\`\n${untracked}\n\`\`\`\n\n`;
	return p.trimEnd();
}

function buildProjectPrompt(langs: Langs, checks: Checks, noStyle: boolean): string {
	const files = gitLsFiles(process.cwd()).trim();
	let p = "Review the overall project structure and code quality. Read source files as needed. Focus on:\n";
	p += "- Architecture and design issues\n";
	p += guidance(langs, noStyle);
	p += "- Anything that should be improved\n\n";
	p = appendChecks(p, checks);
	p += `## Project Files\n\n\`\`\`\n${files}\n\`\`\`\n\nRead the relevant source files and provide a thorough review.`;
	return p;
}

function buildPythonStylePrompt(checks: Checks): string {
	const files = gitLsFiles(process.cwd(), "*.py").trim();
	let p = prompt("python-style.md") + "\n\n";
	p = appendChecks(p, checks);
	p += `## Python Files\n\n\`\`\`\n${files}\n\`\`\`\n\nRead every file above and apply the style rules. Fix everything directly.`;
	return p;
}

// ---------------------------------------------------------------------------
// Duration → git --since format
// ---------------------------------------------------------------------------

function sinceToGit(dur: string): string {
	const n = Number(dur.slice(0, -1));
	const unit = dur.slice(-1);
	const units: Record<string, string> = { m: "minutes", h: "hours", d: "days", w: "weeks" };
	return `${n} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	const args = parseArgs(process.argv);
	const cwd = process.cwd();
	git(["rev-parse", "--git-dir"], cwd); // fail early with a one-line error outside a repo
	const t = args.target;

	// Detect project tooling once, and only if something actually needs it.
	let detected: Tooling | undefined;
	const tooling = () => (detected ??= detectTooling(cwd));

	// ── project ─────────────────────────────────────────────────────────────
	if (t.kind === "project") {
		const langs = resolveLangs(args, tooling);
		const checks = runChecks(langs, tooling);
		process.stdout.write(buildProjectPrompt(langs, checks, args.noStyle));
		return;
	}

	// ── path ─────────────────────────────────────────────────────────────────
	if (t.kind === "path") {
		const files = gitLsFiles(cwd, t.glob).trim();
		if (!files) { process.stderr.write(`No tracked files at ${t.glob}.\n`); process.exit(2); }
		const langs = resolveLangs(args, tooling, extsFromFiles(files));
		const checks = runChecks(langs, tooling);
		let p = `Review ${t.glob} in this repo. Read the files directly. Focus on:\n`;
		p += guidance(langs, args.noStyle);
		p += `- Anything that should be fixed\n\n`;
		p = appendChecks(p, checks);
		p += `## Files\n\n\`\`\`\n${files}\n\`\`\``;
		process.stdout.write(p);
		return;
	}

	// ── python style (--python with no diff target → full style review) ────
	if (args.python && !args.noStyle && t.kind === "uncommitted") {
		const diff = git(["diff", "HEAD"], cwd).trim();
		if (!diff && !untrackedFiles(cwd)) {
			const files = gitLsFiles(cwd, "*.py").trim();
			if (!files) { process.stderr.write("No Python files found.\n"); process.exit(2); }
			const checks = runChecks({ python: true, rust: false, ocaml: false, typescript: false, react: false }, tooling);
			process.stdout.write(buildPythonStylePrompt(checks));
			return;
		}
	}

	// ── get diff ─────────────────────────────────────────────────────────────
	let gitArgs: string[];
	let targetLabel: string;

	switch (t.kind) {
		case "uncommitted":
			gitArgs = ["diff", "HEAD"];
			targetLabel = "uncommitted changes";
			break;
		case "staged":
			gitArgs = ["diff", "--cached"];
			targetLabel = "staged changes";
			break;
		case "last":
			gitArgs = ["diff", `HEAD~${t.n}`, "HEAD"];
			targetLabel = t.n === 1 ? "the last commit" : `the last ${t.n} commits`;
			break;
		case "since": {
			const since = sinceToGit(t.dur);
			const hashes = git(["log", `--since=${since}`, "--format=%H"], cwd).trim();
			if (!hashes) { process.stderr.write(`No commits in the last ${t.dur}.\n`); process.exit(2); }
			const oldest = hashes.split("\n").at(-1)!;
			// The root commit has no parent: diff against the empty tree instead.
			const hasParent = exec("git", ["rev-parse", "--verify", "--quiet", `${oldest}^`], cwd).code === 0;
			gitArgs = ["diff", hasParent ? `${oldest}^` : EMPTY_TREE, "HEAD"];
			targetLabel = `changes in the last ${t.dur}`;
			break;
		}
		case "branch":
			gitArgs = ["diff", `${t.name}...HEAD`];
			targetLabel = `diff vs ${t.name}`;
			break;
		default:
			assertNever(t);
	}

	// Check something actually changed before running linters. Untracked
	// files never show up in a diff, so list them alongside the uncommitted diff.
	const untracked = t.kind === "uncommitted" ? untrackedFiles(cwd) : "";
	const nameOnly = [git([...gitArgs, "--name-only"], cwd).trim(), untracked].filter(Boolean).join("\n");
	if (!nameOnly) {
		process.stderr.write(`Nothing to review (${targetLabel} is empty).\n`);
		process.exit(2);
	}

	const stat = git([...gitArgs, "--stat"], cwd).trim();
	const langs = resolveLangs(args, tooling, extsFromFiles(nameOnly));
	const checks = runChecks(langs, tooling);
	process.stdout.write(buildDiffPrompt(stat, untracked, targetLabel, langs, checks, args.noStyle));
}

try {
	main();
} catch (e: unknown) {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
}
