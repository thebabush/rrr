#!/usr/bin/env -S npx tsx
/**
 * rrr — review review review
 *
 * Runs linters/tests and builds a review prompt for your AI coding agent.
 *
 * Usage:
 *   rrr                    review unstaged changes (default)
 *   rrr staged             review staged changes
 *   rrr project            review whole project (no diff)
 *   rrr --last [N]         review last N commits (default 1)
 *   rrr --since <dur>      review changes in last duration (e.g. 1d, 10h, 30m)
 *   rrr --branch <name>    review diff vs branch
 *   rrr ./path             review specific file, dir, or glob
 *
 *   -p / --python          python lens (ruff, mypy, typing guidance)
 *   -r / --rust            rust lens (cargo clippy, rust guidance)
 *   -o / --ocaml           ocaml lens (dune build, ocamlformat, ocaml guidance)
 *   -t / --typescript      typescript lens (tsc, eslint, biome, ts/react guidance)
 *
 * Exit codes:
 *   0  prompt written to stdout
 *   2  nothing to review
 *   1  error
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

const PROMPTS = join(dirname(realpathSync(process.argv[1])), "prompts");
const prompt = (name: string) => readFileSync(join(PROMPTS, name), "utf8").trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Target =
	| { kind: "unstaged" }
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
	forcedRust: boolean;
	ocaml: boolean;
	typescript: boolean;
}

interface Checks {
	linters: string[];
	tests: string[];
	python: boolean;
	rust: boolean;
	ocaml: boolean;
	typescript: boolean;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const USAGE = `\
Usage: rrr [target] [options]

Targets:
  (none)             review unstaged changes (default)
  staged             review staged changes
  last               review last commit
  --last <N>         review last N commits
  --since <dur>      review changes in last duration (e.g. 1d, 10h, 30m)
  --branch <name>    review diff vs branch
  ./path             review specific file, dir, or glob
  project            review whole project (no diff)

Options:
  -p, --python       python lens (ruff, mypy, typing guidance)
  -r, --rust         rust lens (cargo clippy, rust guidance)
  -o, --ocaml        ocaml lens (dune build, ocamlformat, ocaml guidance)
  -t, --typescript   typescript lens (tsc, eslint, biome, ts/react guidance)
  -S, --no-style     skip language-specific style guidance
  -h, --help         show this help
`;

function parseArgs(argv: string[]): Args {
	const args: Args = { target: { kind: "unstaged" }, python: false, rust: false, ocaml: false, typescript: false, noStyle: false };
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
			args.target = { kind: "last", n: parseInt(val) };
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

		if (a.startsWith("./") || a.startsWith("/") || a.includes("*")) {
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

function exec(cmd: string, args: string[], cwd = process.cwd(), timeoutMs = 120_000) {
	const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8" });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

// ---------------------------------------------------------------------------
// Tooling detection
// ---------------------------------------------------------------------------

function detectPython(cwd: string): { ruff: boolean; mypy: boolean } {
	const pyproject = join(cwd, "pyproject.toml");
	if (!existsSync(pyproject)) return { ruff: false, mypy: false };
	const content = readFileSync(pyproject, "utf8");
	return { ruff: /\bruff\b/.test(content), mypy: /\bmypy\b/.test(content) };
}

function findCargoRoots(cwd: string): string[] {
	const result = exec("git", ["ls-files", "**/Cargo.toml", "Cargo.toml"], cwd);
	const dirs = result.stdout
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

function detectPytest(cwd: string): boolean {
	return existsSync(join(cwd, ".venv/bin/pytest")) && existsSync(join(cwd, "tests"));
}

function findDuneRoots(cwd: string): string[] {
	const result = exec("git", ["ls-files", "**/dune-project", "dune-project"], cwd);
	const dirs = result.stdout
		.split("\n")
		.filter(Boolean)
		.map(f => dirname(f))
		.sort();

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

// Which languages to actually care about, given flags and optionally a set of
// changed file extensions to auto-detect from.
function resolveLangs(args: Args, changedExts?: Set<string>): Langs {
	if (args.python || args.rust || args.ocaml || args.typescript) {
		return { python: args.python, rust: args.rust, forcedRust: args.rust, ocaml: args.ocaml, typescript: args.typescript };
	}
	// auto-detect
	if (changedExts) {
		return {
			python:     changedExts.has(".py"),
			rust:       changedExts.has(".rs"),
			ocaml:      changedExts.has(".ml") || changedExts.has(".mli"),
			typescript: changedExts.has(".ts") || changedExts.has(".tsx"),
			forcedRust: false,
		};
	}
	// project-wide: detect from project structure
	const cwd = process.cwd();
	const ts = detectTypeScript(cwd);
	return {
		python:     detectPython(cwd).ruff || detectPython(cwd).mypy,
		rust:       findCargoRoots(cwd).length > 0,
		ocaml:      findDuneRoots(cwd).length > 0,
		typescript: ts.tsc || ts.eslint || ts.biome,
		forcedRust: false,
	};
}

function extsFromFiles(nameOnly: string): Set<string> {
	const exts = new Set<string>();
	for (const file of nameOnly.split("\n").filter(Boolean)) {
		const dot = file.lastIndexOf(".");
		if (dot !== -1) exts.add(file.slice(dot));
	}
	return exts;
}

// ---------------------------------------------------------------------------
// Linter/test runner
// ---------------------------------------------------------------------------

function runTool(cmd: string, toolArgs: string[], cwd: string): string {
	process.stderr.write(`  ${cmd} ${toolArgs.join(" ")}…\n`);
	try {
		const r = exec(cmd, toolArgs, cwd);
		const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
		return `### ${cmd} ${toolArgs.join(" ")} (${r.code === 0 ? "PASSED ✓" : "FAILED ✗"})\n\n\`\`\`\n${out || "(no output)"}\n\`\`\``;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return `### ${cmd} ${toolArgs.join(" ")} (ERROR)\n\`\`\`\n${msg}\n\`\`\``;
	}
}

function runChecks(langs: Langs): Checks {
	const cwd = process.cwd();
	const linters: string[] = [];
	const tests: string[] = [];

	if (langs.python) {
		const { ruff, mypy } = detectPython(cwd);
		if (ruff || mypy) process.stderr.write("Running Python linters…\n");
		if (ruff) {
			linters.push(runTool(".venv/bin/ruff", ["check", "."], cwd));
			linters.push(runTool(".venv/bin/ruff", ["format", "--check", "."], cwd));
		}
		if (mypy) linters.push(runTool(".venv/bin/mypy", ["."], cwd));
		if (detectPytest(cwd)) {
			process.stderr.write("Running pytest…\n");
			tests.push(runTool(".venv/bin/pytest", ["-x", "-q", "--tb=short"], cwd));
		}
	}

	if (langs.rust) {
		const roots = findCargoRoots(cwd);
		if (roots.length > 0) {
			process.stderr.write("Running cargo clippy…\n");
			for (const root of roots) {
				linters.push(runTool("cargo", ["clippy", "--", "-D", "warnings"], root));
			}
		}
	}

	if (langs.ocaml) {
		const roots = findDuneRoots(cwd);
		if (roots.length > 0) {
			process.stderr.write("Running dune build @check…\n");
			for (const root of roots) {
				linters.push(runTool("dune", ["build", "@check"], root));
				if (detectOcamlformat(root)) {
					const mlFiles = exec("git", ["ls-files", "*.ml", "**/*.ml", "*.mli", "**/*.mli"], root)
						.stdout.trim().split("\n").filter(Boolean);
					if (mlFiles.length > 0) {
						linters.push(runTool("ocamlformat", ["--check", ...mlFiles], root));
					}
				}
			}
			process.stderr.write("Running dune runtest…\n");
			for (const root of roots) {
				tests.push(runTool("dune", ["runtest"], root));
			}
		}
	}

	if (langs.typescript) {
		const { tsc, eslint, biome } = detectTypeScript(cwd);
		if (tsc || eslint || biome) process.stderr.write("Running TypeScript checks…\n");
		if (tsc)    linters.push(runTool("./node_modules/.bin/tsc", ["--noEmit"], cwd));
		if (eslint) linters.push(runTool("./node_modules/.bin/eslint", ["."], cwd));
		if (biome)  linters.push(runTool("./node_modules/.bin/biome", ["check"], cwd));
	}

	return { linters, tests, python: langs.python, rust: langs.rust, ocaml: langs.ocaml, typescript: langs.typescript };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function guidance(checks: Checks, noStyle = false): string {
	let g = "- Bugs, logic errors, or edge cases\n";
	g += "- Code quality issues (naming, structure, duplication)\n";
	g += "- Missing error handling\n";
	if (!noStyle) {
		if (checks.python)     g += prompt("python-guidance.md") + "\n";
		if (checks.rust)       g += prompt("rust-guidance.md") + "\n";
		if (checks.ocaml)      g += prompt("ocaml-guidance.md") + "\n";
		if (checks.typescript) g += prompt("ts-guidance.md") + "\n";
	}
	return g;
}

function appendChecks(p: string, checks: Checks): string {
	if (checks.linters.length) {
		p += "## Linter Results\n\n" + checks.linters.join("\n\n");
		p += "\n\nIf any linters failed, include their issues in your review and fix them.\n\n";
	}
	if (checks.tests.length) {
		p += "## Test Results\n\n" + checks.tests.join("\n\n");
		p += "\n\nIf any tests failed, include their failures in your review and fix them.\n\n";
	}
	return p;
}

function buildDiffPrompt(stat: string, target: string, checks: Checks, noStyle: boolean): string {
	let p = `Review ${target} in this repo. Read the changed files directly to do the review. Focus on:\n`;
	p += guidance(checks, noStyle);
	p += `- Anything that should be fixed\n\n`;
	p = appendChecks(p, checks);
	p += `## Changed Files\n\n\`\`\`\n${stat}\n\`\`\``;
	return p;
}

function buildProjectPrompt(checks: Checks, noStyle: boolean): string {
	const files = exec("git", ["ls-files"], process.cwd()).stdout.trim();
	let p = "Review the overall project structure and code quality. Read source files as needed. Focus on:\n";
	p += "- Architecture and design issues\n";
	p += guidance(checks, noStyle);
	p += "- Anything that should be improved\n\n";
	p = appendChecks(p, checks);
	p += `## Project Files\n\n\`\`\`\n${files}\n\`\`\`\n\nRead the relevant source files and provide a thorough review.`;
	return p;
}

function buildPythonStylePrompt(checks: Checks): string {
	const files = exec("git", ["ls-files", "*.py", "**/*.py"], process.cwd()).stdout.trim();
	let p = prompt("python-style.md") + "\n\n";
	p = appendChecks(p, checks);
	p += `## Python Files\n\n\`\`\`\n${files}\n\`\`\`\n\nRead every file above and apply the style rules. Fix everything directly.`;
	return p;
}

// ---------------------------------------------------------------------------
// Duration → git --since format
// ---------------------------------------------------------------------------

function sinceToGit(dur: string): string {
	const n = parseInt(dur);
	const unit = dur.slice(-1);
	const units: Record<string, string> = { m: "minutes", h: "hours", d: "days", w: "weeks" };
	return `${n} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv);
	const cwd = process.cwd();
	const t = args.target;

	// ── project ─────────────────────────────────────────────────────────────
	if (t.kind === "project") {
		const langs = resolveLangs(args);
		const checks = runChecks(langs);
		process.stdout.write(buildProjectPrompt(checks, args.noStyle));
		return;
	}

	// ── path ─────────────────────────────────────────────────────────────────
	if (t.kind === "path") {
		const files = exec("git", ["ls-files", t.glob], cwd).stdout.trim();
		if (!files) { process.stderr.write(`No tracked files at ${t.glob}.\n`); process.exit(2); }
		const langs = resolveLangs(args, extsFromFiles(files));
		const checks = runChecks(langs);
		let p = `Review ${t.glob} in this repo. Read the files directly. Focus on:\n`;
		p += guidance(checks, args.noStyle);
		p += `- Anything that should be fixed\n\n`;
		p = appendChecks(p, checks);
		p += `## Files\n\n\`\`\`\n${files}\n\`\`\``;
		process.stdout.write(p);
		return;
	}

	// ── python style (--python with no diff target → full style review) ────
	if (args.python && !args.noStyle && t.kind === "unstaged") {
		const diff = exec("git", ["diff"], cwd).stdout.trim();
		if (!diff) {
			const files = exec("git", ["ls-files", "*.py", "**/*.py"], cwd).stdout.trim();
			if (!files) { process.stderr.write("No Python files found.\n"); process.exit(2); }
			const checks = runChecks({ python: true, rust: false, forcedRust: false, ocaml: false, typescript: false });
			process.stdout.write(buildPythonStylePrompt(checks));
			return;
		}
	}

	// ── get diff ─────────────────────────────────────────────────────────────
	let gitArgs: string[];
	let targetLabel: string;

	switch (t.kind) {
		case "unstaged":
			gitArgs = ["diff"];
			targetLabel = "unstaged changes";
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
			const hashes = exec("git", ["log", `--since=${since}`, "--format=%H"], cwd).stdout.trim();
			if (!hashes) { process.stderr.write(`No commits in the last ${t.dur}.\n`); process.exit(2); }
			const oldest = hashes.split("\n").at(-1)!;
			gitArgs = ["diff", `${oldest}^`, "HEAD"];
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

	// Check something actually changed before running linters
	const nameOnly = exec("git", [...gitArgs, "--name-only"], cwd).stdout.trim();
	if (!nameOnly) {
		process.stderr.write(`Nothing to review (${targetLabel} is empty).\n`);
		process.exit(2);
	}

	const stat = exec("git", [...gitArgs, "--stat"], cwd).stdout.trim();
	const langs = resolveLangs(args, extsFromFiles(nameOnly));
	const checks = runChecks(langs);
	process.stdout.write(buildDiffPrompt(stat, targetLabel, checks, args.noStyle));
}

main().catch((e: unknown) => {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
