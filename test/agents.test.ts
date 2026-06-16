// User-defined agents: parsing, layering, and @invocation detection.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile, loadAgents, agentInvocation, agentRouteMode, agentPinId } from "../src/agents.ts";

let home: string, proj: string;
const saved = process.env.GEARBOX_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-agents-home-"));
  proj = mkdtempSync(join(tmpdir(), "gearbox-agents-proj-"));
  process.env.GEARBOX_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = saved;
});

test("parseAgentFile: frontmatter + body; body-less files are rejected", () => {
  const a = parseAgentFile("---\ndescription: reviews diffs\nmodel: claude-opus-4-8\n---\nYou are a reviewer.", "reviewer", "project")!;
  expect(a.name).toBe("reviewer");
  expect(a.description).toBe("reviews diffs");
  expect(a.model).toBe("claude-opus-4-8");
  expect(a.system).toBe("You are a reviewer.");
  expect(parseAgentFile("---\ndescription: empty\n---\n", "x", "project")).toBeNull();
});

test("parseAgentFile: the extended frontmatter is parsed (tools, effort, mode, isolation, …)", () => {
  const a = parseAgentFile(
    [
      "---",
      "description: read-only code reviewer",
      "model: auto",
      "when_to_use: reviewing a diff for bugs or security issues",
      "tools: read_file, search glob",
      "disallowed_tools: write_file edit_file run_shell",
      "effort: HIGH",
      "mode: plan",
      "isolation: worktree",
      "exclude_family: claude, GPT",
      "---",
      "You review code.",
    ].join("\n"),
    "reviewer",
    "project",
  )!;
  expect(a.whenToUse).toBe("reviewing a diff for bugs or security issues");
  expect(a.tools).toEqual(["read_file", "search", "glob"]);
  expect(a.disallowedTools).toEqual(["write_file", "edit_file", "run_shell"]);
  expect(a.effort).toBe("high");
  expect(a.permissionMode).toBe("plan");
  expect(a.isolation).toBe("worktree");
  expect(a.excludeFamily).toEqual(["claude", "gpt"]);
});

test("agentRouteMode/agentPinId: auto is the default, inherit takes the parent pin, an id pins", () => {
  const mk = (model?: string) => ({ name: "x", description: "d", system: "s", source: "project" as const, model });
  // omitted → auto-route (the default for agents)
  expect(agentRouteMode(mk())).toBe("auto");
  expect(agentPinId(mk(), "claude-opus-4-8")).toBeUndefined(); // auto ignores the parent pin
  // explicit auto
  expect(agentRouteMode(mk("auto"))).toBe("auto");
  // inherit → parent's pin if pinned, else route
  expect(agentRouteMode(mk("inherit"))).toBe("inherit");
  expect(agentPinId(mk("inherit"), "gpt-5")).toBe("gpt-5");
  expect(agentPinId(mk("inherit"))).toBeUndefined();
  // a concrete id pins regardless of the parent
  expect(agentRouteMode(mk("claude-opus-4-8"))).toBe("pinned");
  expect(agentPinId(mk("claude-opus-4-8"), "gpt-5")).toBe("claude-opus-4-8");
});

test("loadAgents: explore + review ship built in, auto-routed and read-only", () => {
  const defs = loadAgents(proj);
  const explore = defs.find((a) => a.name === "explore")!;
  expect(explore.source).toBe("builtin");
  expect(agentRouteMode(explore)).toBe("auto"); // model: auto — routed, not pinned
  expect(explore.permissionMode).toBe("plan"); // read-only
  expect(explore.tools).toContain("read_file");
  expect(explore.tools).not.toContain("write_file");
  const review = defs.find((a) => a.name === "review")!;
  expect(agentRouteMode(review)).toBe("auto");
  expect(review.permissionMode).toBe("plan");
  expect(review.effort).toBe("high");
});

test("loadAgents: scout ships built in; project overrides global by name", () => {
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", "reviewer.md"), "global reviewer prompt");
  mkdirSync(join(proj, ".gearbox", "agents"), { recursive: true });
  writeFileSync(join(proj, ".gearbox", "agents", "reviewer.md"), "project reviewer prompt");
  const defs = loadAgents(proj);
  expect(defs.find((a) => a.name === "scout")?.source).toBe("builtin");
  const reviewer = defs.find((a) => a.name === "reviewer")!;
  expect(reviewer.source).toBe("project");
  expect(reviewer.system).toBe("project reviewer prompt");
});

test("agentInvocation: only fires for loaded agent names with a task", () => {
  const inv = agentInvocation("@scout how does ink Transform work?", proj)!;
  expect(inv.agent.name).toBe("scout");
  expect(inv.task).toBe("how does ink Transform work?");
  expect(agentInvocation("@src/App.tsx what is this", proj)).toBeNull(); // a file mention, not an agent
  expect(agentInvocation("@scout", proj)).toBeNull(); // no task
  expect(agentInvocation("plain prompt", proj)).toBeNull();
});
