import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMcpServer, configuredMcpServers, formatMcpConfigList, removeMcpServer, shellSplit, mcpSafeEnv } from "../src/mcp.ts";

test("mcpSafeEnv strips provider credentials before spawning an untrusted MCP server", () => {
  const dirty = {
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "ghp_secret",
    OPENROUTER_API_KEY: "sk-or-secret",
    PATH: "/usr/bin",
    HOME: "/home/me",
    LANG: "en_US.UTF-8",
  } as unknown as NodeJS.ProcessEnv;
  const safe = mcpSafeEnv(dirty);
  // Credentials gone…
  expect(safe.ANTHROPIC_API_KEY).toBeUndefined();
  expect(safe.OPENAI_API_KEY).toBeUndefined();
  expect(safe.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(safe.GITHUB_TOKEN).toBeUndefined();
  expect(safe.OPENROUTER_API_KEY).toBeUndefined();
  // …benign vars the subprocess needs survive.
  expect(safe.PATH).toBe("/usr/bin");
  expect(safe.HOME).toBe("/home/me");
  expect(safe.LANG).toBe("en_US.UTF-8");
});

test("MCP servers can be added, listed, and removed from project config", () => {
  const oldHome = process.env.GEARBOX_HOME;
  const home = mkdtempSync(join(tmpdir(), "gearbox-mcp-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "gearbox-mcp-project-"));
  process.env.GEARBOX_HOME = home;
  try {
    expect(addMcpServer("github", "npx", ["-y", "@modelcontextprotocol/server-github"], { cwd })).toContain("connected github");
    const rows = configuredMcpServers(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "github", scope: "project", config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } });
    expect(formatMcpConfigList(cwd)).toContain("github");
    expect(removeMcpServer("github", { cwd })).toContain("removed github");
    expect(configuredMcpServers(cwd)).toHaveLength(0);
  } finally {
    if (oldHome === undefined) delete process.env.GEARBOX_HOME;
    else process.env.GEARBOX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("MCP shell splitter keeps quoted args together", () => {
  expect(shellSplit('add github npx -y "@modelcontextprotocol/server-github"')).toEqual(["add", "github", "npx", "-y", "@modelcontextprotocol/server-github"]);
});
