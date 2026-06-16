// ── DELEGATION ROLES → ROUTING SIGNALS ────────────────────────────────────────
// A "role" is a reusable archetype for a sub-agent — explore, review, code — that
// carries the routing signals and tool scoping that archetype implies. The point
// of the project is per-task routing; roles let a delegated sub-task say WHAT it
// is ("review this diff") and have the right model + tool posture fall out, with
// no model hardcoded anywhere.
//
// This module is PURE data + tiny pure helpers (no I/O, no model calls), so it is
// fully fixture-testable. The delegation layer (delegate.ts) and the builtin
// agents (agents.ts) consume it; the @agent frontmatter (agents.ts) can override
// any field a role sets.
//
// The signals each role contributes:
//   kind          → the routing task-kind (sets the quality bar)
//   readOnly      → run with no mutating tools (a reviewer/explorer never writes)
//   tools/deny    → explicit tool allow/deny lists (compose with readOnly)
//   effort        → default reasoning effort
//   crossFamily   → prefer a model from a DIFFERENT vendor than the work's author
//                   (resolved to excludeFamily at call time — a same-vendor model
//                   rationalizes its own mistakes; an outside vendor catches them)
//   systemHint    → a short addendum appended to the sub-agent's system prompt
import type { Task } from "../model/selector.ts";
import { modelVendorAliases } from "../model/family.ts";

export type RoleName = "explore" | "review" | "code";

export interface RoleSpec {
  name: RoleName;
  kind?: NonNullable<Task["kind"]>;
  readOnly?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  effort?: string;
  crossFamily?: boolean;
  systemHint: string;
}

// The read-only tool surface shared by explore/review (mirrors the runtime
// readOnlySubset in tools.ts — kept as an explicit allowlist so a role's posture
// is visible and testable without importing the live toolset).
export const READ_ONLY_TOOLS = [
  "read_file",
  "list_dir",
  "search",
  "glob",
  "fetch_url",
  "web_search",
  "code_definition",
  "code_references",
];

export const ROLES: Record<RoleName, RoleSpec> = {
  explore: {
    name: "explore",
    kind: "search",
    readOnly: true,
    tools: READ_ONLY_TOOLS,
    effort: "low",
    systemHint:
      "You are an EXPLORER: map the relevant code and return findings, never edits. Read widely but report tightly — answer the question with file:line citations and a short synthesis, not a file dump. Make no changes.",
  },
  review: {
    name: "review",
    kind: "code", // review is reasoning-heavy → a high bar, like writing the code
    readOnly: true,
    tools: READ_ONLY_TOOLS,
    effort: "high",
    crossFamily: true,
    systemHint:
      "You are a REVIEWER: judge the work for correctness, security, and adherence to the surrounding code's conventions. Read the diff and the code it touches. Report ONLY real, specific issues (file:line + why + a concrete fix), worst-first; if you find nothing real, say so plainly. Make no changes — you review, you do not edit.",
  },
  code: {
    name: "code",
    kind: "code",
    systemHint:
      "You are an IMPLEMENTER: make the smallest change that completes the task, matching the surrounding code's style, and verify it with the project's own checks before reporting.",
  },
};

export function roleByName(name: string): RoleSpec | undefined {
  return ROLES[name.toLowerCase() as RoleName];
}

/** Resolve a role + the author's model into the concrete routing signals to merge
 *  into a delegated Task. `authorModelId` is the model whose work is being
 *  reviewed; a crossFamily role turns it into an excludeFamily entry so the
 *  reviewer routes to a different vendor. Pure. */
export function roleRoutingSignals(
  role: RoleSpec,
  authorModelId?: string,
): Pick<Task, "kind" | "excludeFamily"> {
  const out: Pick<Task, "kind" | "excludeFamily"> = {};
  if (role.kind) out.kind = role.kind;
  if (role.crossFamily && authorModelId) {
    const aliases = modelVendorAliases(authorModelId);
    out.excludeFamily = aliases.length ? aliases : [authorModelId];
  }
  return out;
}
