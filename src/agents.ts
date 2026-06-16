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
import { ROLES, type RoleSpec } from "./agent/roles.ts";

export type AgentRouteMode = "auto" | "inherit" | "pinned";
export type AgentPermissionMode = "normal" | "auto" | "plan" | "yolo";

export interface AgentDef {
  name: string;
  description: string;
  // Raw `model:` frontmatter. A concrete model id pins the agent; the literals
  // "auto" (route per task — the DEFAULT when omitted) and "inherit" (use the
  // parent's pin if pinned, else route) defer the choice to the router. Read it
  // through agentPinId()/agentRouteMode(), never raw, so auto/inherit aren't
  // mistaken for a model id named "auto".
  model?: string;
  // `when_to_use:` — extra selection guidance. RESERVED: parsed and surfaced, but
  // not yet consumed by an automatic agent picker (delegation uses the explicit
  // `role` param today). Forward-compat; don't assume it influences routing.
  whenToUse?: string;
  // `tools:` allowlist / `disallowed_tools:` denylist, applied to the agent's
  // toolset so e.g. a reviewer is read-only. Empty/absent = the full toolset.
  tools?: string[];
  disallowedTools?: string[];
  // `effort:` reasoning-effort hint for the agent's model (clamped to whatever
  // the routed model actually supports).
  effort?: string;
  // `mode:` / `permission_mode:` — permission posture for the agent's turn.
  permissionMode?: AgentPermissionMode;
  // `isolation: worktree` — RESERVED: parsed but not yet consumed for @agent turns
  // (delegate_parallel/spawn already isolate sub-agents in worktrees regardless).
  // Forward-compat; setting it does NOT itself create isolation today.
  isolation?: "none" | "worktree";
  // `exclude_family:` — model families to keep OUT of routing for this agent
  // (e.g. a reviewer that must differ from the author's family).
  excludeFamily?: string[];
  system: string;
  source: "builtin" | "global" | "project";
}

/** Interpret the agent's `model:` field. Omitted → auto-route (the default). */
export function agentRouteMode(a: AgentDef): AgentRouteMode {
  const m = a.model?.trim().toLowerCase();
  if (!m || m === "auto") return "auto";
  if (m === "inherit") return "inherit";
  return "pinned";
}

/** The concrete model id to PIN this agent to, or undefined when it auto-routes
 *  / inherits — the caller then defers to the active selector. `parentPinId` is
 *  the parent turn's pin (if any), used only for the "inherit" mode. */
export function agentPinId(a: AgentDef, parentPinId?: string): string | undefined {
  const mode = agentRouteMode(a);
  if (mode === "pinned") return a.model!.trim();
  if (mode === "inherit") return parentPinId;
  return undefined; // auto
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

// Two builtin agents derived from the delegation roles (src/agent/roles.ts), so
// `@explore <q>` and `@review <diff>` work out of the box and the role's posture
// (read-only, tool scoping, effort, cross-family for the reviewer) is applied
// through the same machinery a user's custom agent uses. model: auto — the right
// model for the task is routed, not hardcoded.
function builtinFromRole(name: AgentDef["name"], description: string, role: RoleSpec): AgentDef {
  return {
    name,
    description,
    source: "builtin",
    model: "auto",
    system: role.systemHint,
    tools: role.tools,
    disallowedTools: role.disallowedTools,
    effort: role.effort,
    permissionMode: role.readOnly ? "plan" : undefined,
  };
}

const EXPLORE = builtinFromRole("explore", "read-only codebase explorer — maps relevant code and reports findings with file:line", ROLES.explore);
const REVIEWER = builtinFromRole("review", "read-only code reviewer — judges a diff for real bugs & security issues (auto-routed; cross-family when delegated)", ROLES.review);

const BUILTINS: AgentDef[] = [SCOUT, EXPLORE, REVIEWER];

// A frontmatter value may be quoted; strip a single pair of surrounding quotes.
const unquote = (s: string): string => s.replace(/^["']([\s\S]*)["']$/, "$1").trim();
// A list value is comma- or whitespace-separated ("read_file, search glob"), and
// also accepts YAML flow-array syntax ("[read_file, run_shell]") — without the
// bracket strip a denylist would parse to ["[read_file", "run_shell]"] and match
// no real tool key, silently leaving the agent with FULL access (a deny-only
// reviewer would still write/shell — fails OPEN, the dangerous direction).
const parseList = (s: string): string[] | undefined => {
  const inner = unquote(s).replace(/^\[([\s\S]*)\]$/, "$1");
  const items = inner.split(/[,\s]+/).map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return items.length ? items : undefined;
};
const parsePermissionMode = (s: string): AgentPermissionMode | undefined => {
  const v = unquote(s).toLowerCase();
  // Only the postures the @agent turn actually ENFORCES are recognized, so the
  // frontmatter never promises behavior that silently does nothing. "plan" makes
  // the turn read-only; "normal" is the default. auto-accept / yolo are reserved
  // (the type carries them) but NOT wired yet — recognizing them would imply an
  // auto-approve grant the runner doesn't apply, so they fall through to normal.
  if (v === "plan" || v === "read-only" || v === "readonly") return "plan";
  if (v === "normal") return "normal";
  return undefined;
};

/** Parse one agent file: optional `---` frontmatter, body = system prompt.
 *  Recognized keys: description, model, name, when_to_use, tools,
 *  disallowed_tools, effort, mode/permission_mode, isolation, exclude_family.
 *  Unknown keys are ignored (forward-compatible). */
export function parseAgentFile(content: string, fallbackName: string, source: AgentDef["source"]): AgentDef | null {
  const def: Partial<AgentDef> = {};
  let description = "";
  let body = content;
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = content.slice(fm[0].length);
    for (const line of fm[1]!.split("\n")) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!m) continue;
      const key = m[1]!.toLowerCase().replace(/-/g, "_");
      const val = m[2]!.trim();
      switch (key) {
        case "description": description = unquote(val); break;
        case "model": def.model = unquote(val) || undefined; break;
        case "name": fallbackName = unquote(val) || fallbackName; break;
        case "when_to_use": case "whentouse": def.whenToUse = unquote(val) || undefined; break;
        case "tools": def.tools = parseList(val); break;
        case "disallowed_tools": case "disallowedtools": def.disallowedTools = parseList(val); break;
        case "effort": def.effort = unquote(val).toLowerCase() || undefined; break;
        case "mode": case "permission_mode": case "permissionmode": def.permissionMode = parsePermissionMode(val); break;
        case "isolation": def.isolation = unquote(val).toLowerCase() === "worktree" ? "worktree" : "none"; break;
        case "exclude_family": case "excludefamily": def.excludeFamily = parseList(val)?.map((x) => x.toLowerCase()); break;
      }
    }
  }
  const system = body.trim();
  if (!system) return null;
  return {
    name: fallbackName.toLowerCase(),
    description: description || system.split("\n")[0]!.slice(0, 80),
    system,
    source,
    ...def,
  };
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
