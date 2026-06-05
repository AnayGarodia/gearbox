import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDiff, diffStat } from "./diff.ts";
import { detectVerificationCommands } from "./verify.ts";

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function rootEntries(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((e) => ![".git", "node_modules", "dist", "build", ".next", "coverage"].includes(e.name))
      .map((e) => e.name + (e.isDirectory() ? "/" : ""))
      .sort()
      .slice(0, 80);
  } catch {
    return [];
  }
}

function detectStack(cwd: string): string[] {
  const out: string[] = [];
  const pkg = readJson(join(cwd, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    out.push("JavaScript/TypeScript");
    if (deps.react || deps.ink) out.push(deps.ink ? "Ink terminal UI" : "React");
    if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) out.push("Bun");
  }
  if (existsSync(join(cwd, "pyproject.toml"))) out.push("Python");
  if (existsSync(join(cwd, "Cargo.toml"))) out.push("Rust");
  if (existsSync(join(cwd, "go.mod"))) out.push("Go");
  return [...new Set(out)];
}

function packageScripts(cwd: string): string[] {
  const pkg = readJson(join(cwd, "package.json"));
  const scripts = pkg?.scripts ?? {};
  return Object.keys(scripts).sort().map((k) => `${k}: ${scripts[k]}`).slice(0, 20);
}

function existingDocs(cwd: string): string[] {
  return ["README.md", "DESIGN.md", "ROADMAP.md", "VISION.md", "AGENTS.md", "CLAUDE.md"]
    .filter((name) => existsSync(join(cwd, name)));
}

export function buildProjectGuide(cwd = process.cwd()): string {
  const name = readJson(join(cwd, "package.json"))?.name ?? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
  const stack = detectStack(cwd);
  const checks = detectVerificationCommands(cwd).map((c) => c.command);
  const scripts = packageScripts(cwd);
  const entries = rootEntries(cwd);
  const docs = existingDocs(cwd);
  return `# ${name} - Gearbox Guide

## What This Project Is

This file was generated from the repository structure so Gearbox has project context before editing.
${stack.length ? `Detected stack: ${stack.join(", ")}.` : "Detected stack: unknown from root files."}

## Run And Verify

${checks.length ? checks.map((c) => `- \`${c}\``).join("\n") : "- No standard verification command was detected. Add one here when known."}

## Layout

${entries.length ? entries.map((e) => `- \`${e}\``).join("\n") : "- Root layout could not be read."}

${scripts.length ? `## Package Scripts\n\n${scripts.map((s) => `- \`${s}\``).join("\n")}\n\n` : ""}## Existing Project Docs

${docs.length ? docs.map((d) => `- \`${d}\``).join("\n") : "- No common docs detected."}

## Agent Conventions

- Read relevant files before editing.
- Keep changes scoped to the user request.
- Do not overwrite unrelated dirty work.
- Run the verification commands above after edits when practical.
`;
}

export function writeProjectGuide(cwd = process.cwd()): { path: string; summary: string; diff: ReturnType<typeof computeDiff> } {
  const path = join(cwd, "GEARBOX.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = buildProjectGuide(cwd);
  writeFileSync(path, after, "utf8");
  const diff = computeDiff(before, after);
  return { path, summary: `wrote GEARBOX.md (${diffStat(diff)})`, diff };
}
