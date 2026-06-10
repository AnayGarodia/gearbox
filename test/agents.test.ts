// User-defined agents: parsing, layering, and @invocation detection.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile, loadAgents, agentInvocation } from "../src/agents.ts";

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
