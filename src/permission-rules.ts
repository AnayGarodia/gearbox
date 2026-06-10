// Project permission rules — OpenCode's `"git push": "ask"` pattern. A
// `.gearbox/permissions.json` in the project (or `$GEARBOX_HOME/permissions.json`
// globally; project wins) pre-decides permission requests by kind + glob:
//
//   {
//     "shell": { "git push*": "ask", "rm *": "deny", "bun test*": "allow" },
//     "edit":  { "src/**": "allow", "*.lock": "deny" },
//     "write": "allow"
//   }
//
// "allow" skips the prompt, "deny" refuses without asking, "ask" forces the
// prompt even in auto-accept mode. A kind can be a single decision string or a
// glob map; the LONGEST matching glob wins (most specific intent). Anything
// unmatched falls through to the normal interactive broker. Pure + tested.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PermKind } from "./permission.ts";

export type RuleDecision = "allow" | "deny" | "ask";
export type KindRules = RuleDecision | Record<string, RuleDecision>;
export interface PermissionRules {
  shell?: KindRules;
  edit?: KindRules;
  write?: KindRules;
}

/** Glob → RegExp: `*` spans anything (incl. /), `?` one char; anchored. */
function globRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/** Pure rule lookup: the decision for (kind, detail), or null = no rule. */
export function ruleFor(rules: PermissionRules | null, kind: PermKind, detail: string): RuleDecision | null {
  const kr = rules?.[kind];
  if (!kr) return null;
  if (typeof kr === "string") return kr;
  let best: { glob: string; decision: RuleDecision } | null = null;
  for (const [glob, decision] of Object.entries(kr)) {
    if (!globRe(glob).test(detail.trim())) continue;
    if (!best || glob.length > best.glob.length) best = { glob, decision };
  }
  return best?.decision ?? null;
}

function readRules(path: string): PermissionRules | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? (j as PermissionRules) : null;
  } catch {
    return null;
  }
}

let cached: { rules: PermissionRules | null; at: number } | null = null;
const TTL = 10_000; // re-read at most every 10s — editable without restarting

/** The merged rules for the current project (project overrides global). */
export function loadPermissionRules(cwd = process.cwd()): PermissionRules | null {
  const now = Date.now();
  if (cached && now - cached.at < TTL) return cached.rules;
  const globalRules = readRules(join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "permissions.json"));
  const projectRules = readRules(join(cwd, ".gearbox", "permissions.json"));
  const merged: PermissionRules | null =
    globalRules || projectRules
      ? {
          shell: mergeKind(globalRules?.shell, projectRules?.shell),
          edit: mergeKind(globalRules?.edit, projectRules?.edit),
          write: mergeKind(globalRules?.write, projectRules?.write),
        }
      : null;
  cached = { rules: merged, at: now };
  return merged;
}

function mergeKind(g: KindRules | undefined, p: KindRules | undefined): KindRules | undefined {
  if (p == null) return g;
  if (g == null) return p;
  if (typeof p === "string" || typeof g === "string") return p; // a blanket project rule wins outright
  return { ...g, ...p };
}

/** Test hook. */
export function clearPermissionRulesCache(): void {
  cached = null;
}
