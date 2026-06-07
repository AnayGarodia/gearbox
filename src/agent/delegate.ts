// Task delegation — the orchestrator hands a self-contained sub-task to a fresh
// sub-agent that runs on the model the router picks as best+cheapest for THAT
// task (any provider — "DeepSeek for code, Haiku for digest" falls out of the
// scorer, no special-casing).
//
//   delegate          — ONE sub-task, runs in the main workspace, sequential.
//   delegate_parallel — MANY independent sub-tasks at once, each in its OWN git
//                       worktree (isolated copy) so their concurrent writes can't
//                       collide; disjoint changes are merged back, overlaps are
//                       reported as conflicts for the orchestrator to resolve.
//
// Depth-1 only: sub-agents don't get these tools, so delegation can't recurse.
// Wiring note: the sub-agent loop (runTask) is INJECTED via `run` so this module
// never imports run.ts — that would be a cycle (run.ts imports this).
import { tool, type Tool } from "ai";
import { z } from "zod";
import { copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { RoutingSelector, classify } from "../model/router.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { recordUsage } from "../accounts/usage.ts";
import { estimateCost, type ModelSpec } from "../providers.ts";
import { spawnSyncProc } from "../proc.ts";
import type { Account } from "../accounts/types.ts";
import type { ResolvedCreds } from "../accounts/types.ts";
import type { OnEvent, Usage } from "./events.ts";

export type SubAgentRunner = (p: {
  model: ModelSpec;
  creds?: ResolvedCreds;
  system: string;
  prompt: string;
  onEvent: OnEvent;
  signal?: AbortSignal;
  root?: string; // workspace root (a parallel sub-agent's git worktree)
}) => Promise<{ text: string; usage: Usage; failure?: { message: string } }>;

const KIND = z.enum(["code", "search", "summarize", "classify", "plan", "chat"]);

const SUBAGENT_SYSTEM =
  "You are a sub-agent inside Gearbox, handling ONE delegated task. You do NOT see the parent conversation — everything you need is in the task description. Use your tools to read the repo, make the requested changes, and verify them. Stay tightly focused on the task; don't do unrelated work. When finished, reply with a short report: which files you changed and anything the orchestrator needs to know.";

let counter = 0;

// ── routing a sub-task ────────────────────────────────────────────────────────
type Routed = { model: ModelSpec; account?: Account };
function routeSubTask(task: string, kind?: z.infer<typeof KIND>): Routed | { error: string } {
  const k = kind ?? classify(task);
  let choice;
  try {
    choice = new RoutingSelector().select({ prompt: task, kind: k, requires: ["tools"] });
  } catch (e: any) {
    return { error: `no model available for this sub-task (${e?.message ?? e})` };
  }
  // The sub-agent runs in Gearbox's own loop with our tools, so it needs an
  // in-loop model; a flat-rate subscription seat (vendor CLI) can't host it.
  if (choice.backend?.kind === "cli") {
    return { error: `routed to the ${choice.model.label} subscription, which can't host a sub-agent — add an API key` };
  }
  const account = choice.backend?.kind === "in-loop" ? choice.backend.account : undefined;
  return { model: choice.model, account };
}

// Run one routed sub-agent. Records its spend; returns its report text.
async function runOne(
  run: SubAgentRunner,
  routed: Routed,
  task: string,
  opts: { signal?: AbortSignal; root?: string },
): Promise<{ ok: boolean; text: string }> {
  const creds = routed.account ? await resolveCreds(routed.account) : undefined;
  const noop: OnEvent = () => {};
  const r = await run({ model: routed.model, creds, system: SUBAGENT_SYSTEM, prompt: task, onEvent: noop, signal: opts.signal, root: opts.root });
  const costUSD = estimateCost([{ model: routed.model.id, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }]);
  if (routed.account) recordUsage({ accountId: routed.account.id, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUSD, estimated: true });
  if (r.failure) return { ok: false, text: `failed: ${r.failure.message}` };
  return { ok: true, text: r.text || "(no report)" };
}

// ── git worktree isolation (for parallel writes) ──────────────────────────────
function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSyncProc(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: (r.exitCode ?? 1) === 0, out: r.stdout.toString().trim() };
}
function gitToplevel(): string | null {
  const r = git(["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? r.out : null;
}
function addWorktree(repoRoot: string, dir: string): boolean {
  return git(["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"]).ok;
}
function removeWorktree(repoRoot: string, dir: string): void {
  git(["-C", repoRoot, "worktree", "remove", "--force", dir]);
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
// Files a sub-agent changed in its worktree, vs HEAD. Returns {path, deleted}.
function changedFiles(dir: string): { path: string; deleted: boolean }[] {
  git(["-C", dir, "add", "-A"]); // stage so untracked files show up
  const r = git(["-C", dir, "status", "--porcelain"]);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").map((line) => {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    return { path, deleted: status.includes("D") };
  }).filter((c) => c.path);
}

// ── the tools ─────────────────────────────────────────────────────────────────
export function makeDelegateTools(opts: { onEvent: OnEvent; signal?: AbortSignal; run: SubAgentRunner }): Record<string, Tool<any, any>> {
  const { onEvent, signal, run } = opts;

  const delegate = tool({
    description:
      "Hand a self-contained sub-task to a fresh sub-agent that runs on the model best suited and cheapest for it (auto-routed across your providers), with full file tools in this same repo. Use it to offload a bounded chunk — a focused refactor, bulk edits, reading/research, code generation — so you stay the orchestrator while a cheaper/faster/specialist model does the legwork. The sub-agent does NOT see this conversation, so make `task` completely self-contained. It runs to completion and returns a report. Do small things yourself; delegate sizable or specialist chunks.",
    inputSchema: z.object({
      task: z.string().describe("The complete, self-contained sub-task: what to do, which files, constraints, definition of done."),
      kind: KIND.optional().describe("Optional task-kind hint to steer model routing (inferred if omitted)."),
    }),
    execute: async ({ task, kind }) => {
      const routed = routeSubTask(task, kind);
      if ("error" in routed) return `delegation skipped: ${routed.error}. Do it yourself.`;
      const id = `delegate-${++counter}`;
      onEvent({ type: "tool-start", id, name: "delegate", arg: `→ ${routed.model.label} · ${task.slice(0, 72)}` });
      let res: { ok: boolean; text: string };
      try {
        res = await runOne(run, routed, task, { signal }); // sequential → runs in the main workspace
      } catch (e: any) {
        onEvent({ type: "tool-end", id, ok: false, summary: `${routed.model.label} · crashed` });
        return `sub-agent (${routed.model.label}) crashed: ${e?.message ?? e}`;
      }
      onEvent({ type: "tool-end", id, ok: res.ok, summary: routed.model.label });
      return res.text;
    },
  });

  const delegate_parallel = tool({
    description:
      "Run SEVERAL independent sub-tasks at once, each on its own best-routed model AND its own isolated git worktree, so their concurrent file writes can't collide. Use when you have 2+ chunks that touch DIFFERENT files and don't depend on each other (e.g. 'add tests to module A', 'document module B', 'refactor module C'). Each sub-task is self-contained (the sub-agents don't see this conversation or each other). When all finish, their changes are merged back into the repo; any two sub-tasks that edited the SAME file are reported as conflicts for you to resolve. Requires a git repo. For dependent or same-file work, use `delegate` one at a time instead.",
    inputSchema: z.object({
      tasks: z.array(z.object({
        task: z.string().describe("A complete, self-contained sub-task touching files independent of the others."),
        kind: KIND.optional(),
      })).min(2).max(6).describe("2-6 independent sub-tasks to run concurrently."),
    }),
    execute: async ({ tasks }) => {
      const repoRoot = gitToplevel();
      if (!repoRoot) return "parallel delegation needs a git repo (it isolates each sub-agent in a worktree). Use `delegate` one task at a time instead.";
      const batch = ++counter;
      const groupId = `delegate_parallel-${batch}`;
      onEvent({ type: "tool-start", id: groupId, name: "delegate_parallel", arg: `${tasks.length} sub-tasks in parallel` });

      // 1) Route + create an isolated worktree per task (sequential setup).
      type Job = { idx: number; task: string; routed: Routed; dir: string };
      const jobs: Job[] = [];
      const skipped: string[] = [];
      const created: string[] = [];
      for (const [idx, t] of tasks.entries()) {
        const routed = routeSubTask(t.task, t.kind);
        if ("error" in routed) { skipped.push(`#${idx + 1}: ${routed.error}`); continue; }
        const dir = join(tmpdir(), `gearbox-fanout-${batch}-${idx}-${Date.now()}`);
        if (!addWorktree(repoRoot, dir)) { skipped.push(`#${idx + 1}: couldn't create a worktree`); continue; }
        created.push(dir);
        jobs.push({ idx, task: t.task, routed, dir });
      }

      try {
        // 2) Run all sub-agents CONCURRENTLY, each in its own worktree.
        const outcomes = await Promise.all(jobs.map(async (j) => {
          const jid = `${groupId}:${j.idx}`;
          onEvent({ type: "tool-start", id: jid, name: "delegate", arg: `#${j.idx + 1} → ${j.routed.model.label} · ${j.task.slice(0, 56)}` });
          let res: { ok: boolean; text: string };
          try { res = await runOne(run, j.routed, j.task, { signal, root: j.dir }); }
          catch (e: any) { res = { ok: false, text: `crashed: ${e?.message ?? e}` }; }
          onEvent({ type: "tool-end", id: jid, ok: res.ok, summary: j.routed.model.label });
          return { j, res, changed: res.ok ? changedFiles(j.dir) : [] };
        }));

        // 3) Detect conflicts (a file touched by >1 sub-task), merge the rest back.
        const writers = new Map<string, number[]>();
        for (const o of outcomes) for (const c of o.changed) {
          writers.set(c.path, [...(writers.get(c.path) ?? []), o.j.idx]);
        }
        const conflicts = [...writers.entries()].filter(([, who]) => who.length > 1);
        const conflictSet = new Set(conflicts.map(([p]) => p));
        let applied = 0;
        for (const o of outcomes) {
          for (const c of o.changed) {
            if (conflictSet.has(c.path)) continue; // leave conflicting files for the orchestrator
            const dst = join(repoRoot, c.path);
            try {
              if (c.deleted) { if (existsSync(dst)) rmSync(dst, { force: true }); }
              else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(join(o.j.dir, c.path), dst); }
              applied++;
            } catch { /* skip a file we couldn't merge */ }
          }
        }

        // 4) Report.
        const lines: string[] = [];
        for (const o of outcomes) lines.push(`#${o.j.idx + 1} (${o.j.routed.model.label}): ${o.res.text.split("\n")[0]?.slice(0, 160) ?? ""}`);
        const parts = [`Ran ${outcomes.length} sub-tasks in parallel · merged ${applied} file change(s).`];
        if (conflicts.length) parts.push(`CONFLICTS (same file edited by multiple sub-tasks — NOT applied; resolve yourself): ${conflicts.map(([p]) => p).join(", ")}.`);
        if (skipped.length) parts.push(`Skipped: ${skipped.join("; ")}.`);
        onEvent({ type: "tool-end", id: groupId, ok: true, summary: `${outcomes.length} done · ${applied} merged${conflicts.length ? ` · ${conflicts.length} conflict(s)` : ""}` });
        return [parts.join(" "), "", ...lines].join("\n");
      } finally {
        for (const dir of created) removeWorktree(repoRoot, dir); // always clean up worktrees
      }
    },
  });

  return { delegate, delegate_parallel };
}
