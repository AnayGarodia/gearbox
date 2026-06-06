import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMcpServer, configuredMcpServers, formatMcpConfigList, removeMcpServer, shellSplit } from "../src/mcp.ts";

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
