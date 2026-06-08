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
import { copyFileSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { RoutingSelector, classify } from "../model/router.ts";
import { FixedSelector } from "../model/selector.ts";
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

// The sub-agent's report's first meaningful line — a far more useful tool-end
// summary than repeating the model label (already shown in the head).
const reportLine = (text: string): string => {
  const l = (text.split("\n").find((x) => x.trim()) ?? "").trim();
  return l.length > 64 ? l.slice(0, 63).trimEnd() + "…" : l;
};

// A structured digest of a sub-agent's result for the ORCHESTRATOR (not the UI):
// a bounded outcome plus the concrete files it changed. The first-line-only report
// used to drop files-changed / test-status, so the orchestrator would re-read or
// re-delegate to rediscover what happened — a whole wasted turn. The files list is
// already computed (git status of the worktree), so this costs ~nothing and pays
// for itself by preventing redundant exploration.
const subAgentDigest = (text: string, changed: { path: string }[]): string => {
  const outcome = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .slice(0, 220);
  const files = changed.map((c) => c.path);
  const filesStr = files.length
    ? ` · changed: ${files.slice(0, 8).join(", ")}${files.length > 8 ? `, +${files.length - 8} more` : ""}`
    : " · no file changes";
  return (outcome || "(no report)") + filesStr;
};

// One-line task preview for the tool head: collapse whitespace and truncate at a
// word boundary, stripping a dangling quote/backtick/punctuation so it never ends
// mid-token (the "… test/tokens.test.ts for `" cut-off).
const clipTask = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:`'"(–-]+$/, "") + "…";
};

// ── routing a sub-task ────────────────────────────────────────────────────────
type Routed = { model: ModelSpec; account?: Account };
function routeSubTask(task: string, kind?: z.infer<typeof KIND>, pinnedModelId?: string): Routed | { error: string } {
  const k = kind ?? classify(task);
  let choice;
  try {
    // An explicit pin (a /model pin or "use opus" on the parent turn) wins, so the
    // sub-task runs the model the user asked for; otherwise auto-route per task.
    choice = (pinnedModelId ? new FixedSelector(pinnedModelId) : new RoutingSelector()).select({ prompt: task, kind: k, requires: ["tools"] });
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

// A compact "what the sub-agent is doing right now" line, streamed onto its
// delegate line so the sub-agent is never a silent black box. Dependency-free (no
// UI imports — this is the agent layer): a tiny verb map over the in-loop tools +
// a path relativized against the sub-agent's workspace root.
const subVerb = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes("read")) return "reading";
  if (n === "file_change" || n.includes("write")) return "writing";
  if (n.includes("edit")) return "editing";
  if (n === "run_shell" || n === "command_execution" || n === "bash") return "running";
  if (n.includes("list")) return "listing";
  if (n === "glob") return "globbing";
  if (n === "search") return "searching";
  if (n.includes("verif")) return "verifying";
  return name;
};
const subActivityLine = (name: string, arg: string | undefined, root?: string): string => {
  const a = (arg ?? "").replace(/\s+/g, " ").trim();
  const base = root ?? process.cwd();
  const rel = a.startsWith(base + "/") ? a.slice(base.length + 1) : a;
  return ("→ " + subVerb(name) + (rel ? " " + rel : "")).slice(0, 72);
};

// Run one routed sub-agent. Records its spend; returns its report text. When
// `onActivity` is given, each tool the sub-agent starts streams up as a live line.
async function runOne(
  run: SubAgentRunner,
  routed: Routed,
  task: string,
  opts: { signal?: AbortSignal; root?: string; onActivity?: (line: string) => void },
): Promise<{ ok: boolean; text: string }> {
  const creds = routed.account ? await resolveCreds(routed.account) : undefined;
  const subOnEvent: OnEvent = opts.onActivity
    ? (e) => { if (e.type === "tool-start") opts.onActivity!(subActivityLine(e.name, e.arg, opts.root)); }
    : () => {};
  const r = await run({ model: routed.model, creds, system: SUBAGENT_SYSTEM, prompt: task, onEvent: subOnEvent, signal: opts.signal, root: opts.root });
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
function removeWorktree(repoRoot: string, dir: string): void {
  git(["-C", repoRoot, "worktree", "remove", "--force", dir]);
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
// Parse `git status --porcelain` into {path, deleted}; optionally stage first so
// untracked files are included. Handles renames (takes the new path).
function changesIn(root: string, stage: boolean): { path: string; deleted: boolean }[] {
  if (stage) git(["-C", root, "add", "-A"]);
  const r = git(["-C", root, "status", "--porcelain"]);
  if (!r.ok || !r.out) return [];
  const out: { path: string; deleted: boolean }[] = [];
  for (const line of r.out.split("\n")) {
    if (!line) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ")[1]!.trim(); // rename → new path
    // strip surrounding quotes git adds for paths with spaces
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) out.push({ path, deleted: status.includes("D") });
  }
  return out;
}
// Create an isolated worktree at HEAD, then SEED it with the parent's current
// uncommitted state (so sub-agents see the orchestrator's in-flight edits) and
// baseline-commit it — so the sub-agent's own changes later measure against the
// parent state, not HEAD (otherwise every worktree would re-report the parent's
// edits and they'd all "conflict").
function addSeededWorktree(repoRoot: string, dir: string): boolean {
  if (!git(["-C", repoRoot, "worktree", "add", "--detach", dir, "HEAD"]).ok) return false;
  for (const c of changesIn(repoRoot, false)) {
    const src = join(repoRoot, c.path), dst = join(dir, c.path);
    try {
      if (c.deleted) { if (existsSync(dst)) rmSync(dst, { force: true }); }
      else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
    } catch { /* skip a file we can't seed */ }
  }
  git(["-C", dir, "add", "-A"]);
  git(["-C", dir, "commit", "-q", "-m", "gearbox-fanout-baseline", "--no-verify"]);
  return true;
}
// 3-way auto-merge a file that multiple worktrees edited, into repoRoot. base =
// the parent's current file (the shared seed). Non-overlapping hunks combine
// cleanly; truly-overlapping edits leave <<<<<< conflict markers. Returns true if
// markers were left (so the orchestrator knows to resolve them).
function mergeFileBack(repoRoot: string, path: string, dirs: string[]): boolean {
  const baseAbs = join(repoRoot, path);
  const tmps: string[] = [];
  const tmp = (tag: string) => { const p = join(tmpdir(), `gearbox-merge-${++counter}-${tag}`); tmps.push(p); return p; };
  const base = tmp("base");
  try { copyFileSync(baseAbs, base); } catch { writeFileSync(base, ""); } // new file → empty base
  let current = base;
  let conflicted = false;
  try {
    for (const dir of dirs) {
      const other = join(dir, path);
      if (!existsSync(other)) continue;
      const r = spawnSyncProc(["git", "merge-file", "-p", current, base, other], { stdout: "pipe", stderr: "pipe" });
      if ((r.exitCode ?? 0) !== 0) conflicted = true; // >0 = conflicts, <0 = error
      const next = tmp("step");
      writeFileSync(next, r.stdout);
      current = next;
    }
    mkdirSync(dirname(baseAbs), { recursive: true });
    copyFileSync(current, baseAbs);
  } catch { conflicted = true; }
  finally { for (const t of tmps) { try { rmSync(t, { force: true }); } catch {} } }
  return conflicted;
}

// ── the tools ─────────────────────────────────────────────────────────────────
export function makeDelegateTools(opts: { onEvent: OnEvent; signal?: AbortSignal; run: SubAgentRunner; pinnedModelId?: string }): Record<string, Tool<any, any>> {
  const { onEvent, signal, run } = opts;

  const delegate = tool({
    description:
      "Hand a self-contained sub-task to a fresh sub-agent that runs on the model best suited and cheapest for it (auto-routed across your providers), with full file tools in this same repo. Use it to offload a bounded chunk — a focused refactor, bulk edits, reading/research, code generation — so you stay the orchestrator while a cheaper/faster/specialist model does the legwork. The sub-agent does NOT see this conversation, so make `task` completely self-contained. It runs to completion and returns a report. Do small things yourself; delegate sizable or specialist chunks.",
    inputSchema: z.object({
      task: z.string().describe("The complete, self-contained sub-task: what to do, which files, constraints, definition of done."),
      kind: KIND.optional().describe("Optional task-kind hint to steer model routing (inferred if omitted)."),
    }),
    execute: async ({ task, kind }) => {
      const routed = routeSubTask(task, kind, opts.pinnedModelId);
      if ("error" in routed) return `delegation skipped: ${routed.error}. Do it yourself.`;
      const id = `delegate-${++counter}`;
      onEvent({ type: "tool-start", id, name: "delegate", arg: `→ ${routed.model.label} · ${clipTask(task, 72)}` });
      let res: { ok: boolean; text: string };
      try {
        // sequential → runs in the main workspace; stream its actions onto this line.
        res = await runOne(run, routed, task, { signal, onActivity: (line) => onEvent({ type: "tool-stream", id, delta: line + "\n" }) });
      } catch (e: any) {
        onEvent({ type: "tool-end", id, ok: false, summary: `${routed.model.label} · crashed` });
        return `sub-agent (${routed.model.label}) crashed: ${e?.message ?? e}`;
      }
      onEvent({ type: "tool-end", id, ok: res.ok, summary: reportLine(res.text) || routed.model.label });
      return res.text;
    },
  });

  const delegate_parallel = tool({
    description:
      "Run SEVERAL independent sub-tasks at once, each on its own best-routed model AND its own isolated git worktree (seeded with your current uncommitted edits), so their concurrent file writes can't collide. Use when you have 2+ chunks that are mostly independent (e.g. 'add tests to module A', 'document module B', 'refactor module C'). Each sub-task is self-contained (the sub-agents don't see this conversation or each other). When all finish, changes are merged back: files touched by one sub-task apply directly; a file touched by several is 3-way auto-merged (non-overlapping edits combine cleanly; only truly-overlapping edits leave conflict markers for you to resolve). Requires a git repo. For tightly-coupled work, use `delegate` one at a time instead.",
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
        const routed = routeSubTask(t.task, t.kind, opts.pinnedModelId);
        if ("error" in routed) { skipped.push(`#${idx + 1}: ${routed.error}`); continue; }
        const dir = join(tmpdir(), `gearbox-fanout-${batch}-${idx}-${Date.now()}`);
        if (!addSeededWorktree(repoRoot, dir)) { skipped.push(`#${idx + 1}: couldn't create a worktree`); continue; }
        created.push(dir);
        jobs.push({ idx, task: t.task, routed, dir });
      }

      try {
        // 2) Run all sub-agents CONCURRENTLY, each in its own worktree.
        const outcomes = await Promise.all(jobs.map(async (j) => {
          const jid = `${groupId}:${j.idx}`;
          onEvent({ type: "tool-start", id: jid, name: "delegate", arg: `#${j.idx + 1} → ${j.routed.model.label} · ${clipTask(j.task, 56)}` });
          let res: { ok: boolean; text: string };
          try { res = await runOne(run, j.routed, j.task, { signal, root: j.dir, onActivity: (line) => onEvent({ type: "tool-stream", id: jid, delta: line + "\n" }) }); }
          catch (e: any) { res = { ok: false, text: `crashed: ${e?.message ?? e}` }; }
          onEvent({ type: "tool-end", id: jid, ok: res.ok, summary: reportLine(res.text) || j.routed.model.label });
          return { j, res, changed: res.ok ? changesIn(j.dir, true) : [] }; // sub-agent's changes vs the seeded baseline
        }));

        // 3) Merge back. One writer → apply directly. Multiple writers → 3-way
        //    auto-merge (non-overlapping edits combine; overlaps leave markers).
        const writers = new Map<string, { dir: string; deleted: boolean }[]>();
        for (const o of outcomes) for (const c of o.changed) {
          writers.set(c.path, [...(writers.get(c.path) ?? []), { dir: o.j.dir, deleted: c.deleted }]);
        }
        let applied = 0, autoMerged = 0;
        const conflicted: string[] = [];
        for (const [path, who] of writers) {
          const dst = join(repoRoot, path);
          // Capture the pre-merge state so these land in the turn's change set:
          // drives the end-of-turn summary, post-turn verification, and /undo + /diff
          // — delegated edits were previously invisible to all three.
          const existed = existsSync(dst);
          const before = existed ? (() => { try { return readFileSync(dst, "utf8"); } catch { return ""; } })() : "";
          if (who.length === 1) {
            const w = who[0]!;
            try {
              if (w.deleted) { if (existed) rmSync(dst, { force: true }); }
              else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(join(w.dir, path), dst); }
              applied++;
            } catch { continue; /* skip a file we couldn't apply — don't emit a phantom change */ }
          } else {
            const hadMarkers = mergeFileBack(repoRoot, path, who.filter((w) => !w.deleted).map((w) => w.dir));
            autoMerged++;
            if (hadMarkers) conflicted.push(path);
          }
          // Path relative to cwd to match the edit/write tools' file-change convention.
          onEvent({ type: "file-change", path: relative(process.cwd(), dst), before, existed });
        }

        // 4) Report.
        const lines: string[] = [];
        for (const o of outcomes) lines.push(`#${o.j.idx + 1} (${o.j.routed.model.label}): ${subAgentDigest(o.res.text, o.changed)}`);
        const parts = [`Ran ${outcomes.length} sub-tasks in parallel · applied ${applied} file change(s)${autoMerged ? `, 3-way-merged ${autoMerged} shared file(s)` : ""}.`];
        if (conflicted.length) parts.push(`Conflict markers left in (resolve these): ${conflicted.join(", ")}.`);
        if (skipped.length) parts.push(`Skipped: ${skipped.join("; ")}.`);
        onEvent({ type: "tool-end", id: groupId, ok: true, summary: `${outcomes.length} done · ${applied + autoMerged} merged${conflicted.length ? ` · ${conflicted.length} w/ markers` : ""}` });
        return [parts.join(" "), "", ...lines].join("\n");
      } finally {
        for (const dir of created) removeWorktree(repoRoot, dir); // always clean up worktrees
      }
    },
  });

  return { delegate, delegate_parallel };
}
