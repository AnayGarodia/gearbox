// User-defined agents — OpenCode's custom-agent pattern on gearbox's routing.
// A markdown file at `.gearbox/agents/<name>.md` (project) or
// `~/.gearbox/agents/<name>.md` (global; project wins by name) defines one:
//
//   ---
//   description: reviews diffs for security issues
//   model: claude-opus-4-8        # optional — otherwise the router picks
//   ---
//   You are a security reviewer. For every diff …
//
// Invoke by typing `@<name> <task>` as a prompt: the turn runs with the
// agent's system prompt appended and its model pinned (when set) — everything
// else (tools, permissions, spend, verify) is the normal turn machinery.
// `/agents` lists what's loaded. Scout ships built in.
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  system: string;
  source: "builtin" | "global" | "project";
}

// Scout — the most-praised OpenCode subagent, rebuilt on gearbox primitives:
// instead of guessing what a library does, it clones the real source shallowly
// into a cache and reads it.
const SCOUT: AgentDef = {
  name: "scout",
  description: "dependency & docs researcher — reads REAL library source instead of guessing",
  source: "builtin",
  system: [
    "You are Scout, a research agent. Your job: answer questions about libraries,",
    "frameworks, and APIs from PRIMARY SOURCES, never from memory alone.",
    "Method, in order:",
    "1. Find the exact dependency version in this project's manifest (package.json,",
    "   pyproject.toml, go.mod, Cargo.toml) — answers must match the INSTALLED version.",
    "2. Check node_modules (or the language's equivalent) first — the installed",
    "   source/types are already on disk and authoritative.",
    "3. When the installed copy isn't enough, shallow-clone the upstream repo into",
    "   the scout cache and read it there:",
    "     git clone --depth 1 <repo-url> ~/.gearbox/scout-cache/<name>",
    "   (or `git -C ~/.gearbox/scout-cache/<name> pull --depth 1` when it exists).",
    "4. Use web_search/fetch_url for changelogs, migration guides, and issues.",
    "Answer with file:line citations into the real source. If you could not verify",
    "a claim against source or docs, say so explicitly instead of guessing.",
  ].join("\n"),
};

const BUILTINS: AgentDef[] = [SCOUT];

/** Parse one agent file: optional `---` frontmatter (description/model), body = system prompt. */
export function parseAgentFile(content: string, fallbackName: string, source: AgentDef["source"]): AgentDef | null {
  let description = "";
  let model: string | undefined;
  let body = content;
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = content.slice(fm[0].length);
    for (const line of fm[1]!.split("\n")) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!m) continue;
      if (m[1] === "description") description = m[2]!.trim();
      if (m[1] === "model") model = m[2]!.trim() || undefined;
      if (m[1] === "name") fallbackName = m[2]!.trim() || fallbackName;
    }
  }
  const system = body.trim();
  if (!system) return null;
  return { name: fallbackName.toLowerCase(), description: description || system.split("\n")[0]!.slice(0, 80), model, system, source };
}

function readDir(dir: string, source: AgentDef["source"]): AgentDef[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .map((f) => {
        try {
          return parseAgentFile(readFileSync(join(dir, f), "utf8"), basename(f, ".md"), source);
        } catch {
          return null;
        }
      })
      .filter((a): a is AgentDef => a !== null);
  } catch {
    return [];
  }
}

/** All agents: builtins ← global ← project (later wins by name). */
export function loadAgents(projectDir = process.cwd()): AgentDef[] {
  const home = process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
  const byName = new Map<string, AgentDef>();
  for (const a of [...BUILTINS, ...readDir(join(home, "agents"), "global"), ...readDir(join(projectDir, ".gearbox", "agents"), "project")]) {
    byName.set(a.name, a);
  }
  return [...byName.values()];
}

export function agentByName(name: string, projectDir = process.cwd()): AgentDef | undefined {
  return loadAgents(projectDir).find((a) => a.name === name.toLowerCase());
}

/** Parse a leading `@name task…` invocation. Null unless `name` is a loaded agent. */
export function agentInvocation(prompt: string, projectDir = process.cwd()): { agent: AgentDef; task: string } | null {
  const m = prompt.match(/^@([\w-]+)\s+([\s\S]+)$/);
  if (!m) return null;
  const agent = agentByName(m[1]!, projectDir);
  if (!agent) return null;
  return { agent, task: m[2]!.trim() };
}
