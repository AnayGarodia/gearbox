import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tool, jsonSchema } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OnEvent } from "./agent/events.ts";
import { requestPermission } from "./permission.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
  servers?: Record<string, McpServerConfig>;
}

type Connected = { name: string; config: McpServerConfig; client: Client; tools: any[] };

let connectedPromise: Promise<Connected[]> | null = null;

const HOME = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");

function readConfigFile(path: string): McpConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

function normalizeConfig(cwd = process.cwd()): Record<string, McpServerConfig> {
  const global = readConfigFile(join(HOME(), "mcp.json"));
  const local = readConfigFile(join(cwd, ".gearbox", "mcp.json"));
  const compat = readConfigFile(join(cwd, ".mcp.json"));
  const merged = { ...(global.mcpServers ?? global.servers ?? {}), ...(compat.mcpServers ?? compat.servers ?? {}), ...(local.mcpServers ?? local.servers ?? {}) };
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(merged)) {
    if (!cfg || cfg.disabled || !cfg.command) continue;
    out[name] = {
      command: expandEnv(cfg.command),
      args: (cfg.args ?? []).map(expandEnv),
      cwd: cfg.cwd ? expandEnv(cfg.cwd) : cwd,
      env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expandEnv(String(v))])) : undefined,
    };
  }
  return out;
}

function safeToolName(server: string, name: string): string {
  return `mcp_${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

async function connectAll(): Promise<Connected[]> {
  const configs = normalizeConfig();
  const rows: Connected[] = [];
  await Promise.all(Object.entries(configs).map(async ([name, config]) => {
    try {
      const client = new Client({ name: "gearbox", version: "0.1" }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
        stderr: "pipe",
      });
      await client.connect(transport);
      const listed = await client.listTools({}, { timeout: 10_000 });
      rows.push({ name, config, client, tools: listed.tools ?? [] });
    } catch {
      /* Bad MCP servers should not prevent Gearbox from starting. */
    }
  }));
  return rows;
}

async function connected(): Promise<Connected[]> {
  connectedPromise ??= connectAll();
  return connectedPromise;
}

function formatMcpResult(result: any): string {
  const content = result?.content ?? [];
  if (!Array.isArray(content) || !content.length) return JSON.stringify(result ?? {});
  return content.map((part: any) => {
    if (part.type === "text") return part.text ?? "";
    if (part.type === "image") return `[image ${part.mimeType ?? ""} ${String(part.data ?? "").length} base64 chars]`;
    if (part.type === "resource") return `[resource ${part.resource?.uri ?? ""}]\n${part.resource?.text ?? part.resource?.blob ?? ""}`;
    if (part.uri) return `[resource ${part.name ?? part.uri}] ${part.uri}`;
    return JSON.stringify(part);
  }).filter(Boolean).join("\n\n");
}

export async function mcpToolSummary(): Promise<string> {
  const rows = await connected();
  if (!rows.length) return "No MCP servers connected. Configure ~/.gearbox/mcp.json or .gearbox/mcp.json.";
  return rows.flatMap((s) => s.tools.map((t) => `${safeToolName(s.name, t.name).padEnd(34)} ${t.description ?? ""}`)).join("\n");
}

export async function mcpTools(onEvent?: OnEvent, readOnly = false): Promise<Record<string, any>> {
  const rows = await connected();
  const out: Record<string, any> = {};
  for (const server of rows) {
    for (const remote of server.tools) {
      if (readOnly && remote.annotations?.readOnlyHint !== true) continue;
      const name = safeToolName(server.name, remote.name);
      out[name] = tool({
        description: `[MCP:${server.name}] ${remote.description ?? remote.title ?? remote.name}`,
        inputSchema: jsonSchema((remote.inputSchema ?? { type: "object", properties: {} }) as any),
        execute: async (input: any) => {
          const risky = remote.annotations?.destructiveHint || remote.annotations?.openWorldHint || !remote.annotations?.readOnlyHint;
          if (risky && !(await requestPermission({ kind: "shell", title: "Run MCP tool", detail: `${server.name}.${remote.name}` }))) {
            throw new Error("Permission denied by the user — they declined this MCP tool.");
          }
          onEvent?.({ type: "phase", label: "using MCP", detail: `${server.name}.${remote.name}`, state: "running" });
          const result = await server.client.callTool({ name: remote.name, arguments: input ?? {} }, undefined, { timeout: 120_000 });
          return formatMcpResult(result);
        },
      });
    }
  }
  return out;
}

export function mcpConfigPaths(cwd = process.cwd()): string[] {
  return [join(HOME(), "mcp.json"), join(cwd, ".mcp.json"), join(cwd, ".gearbox", "mcp.json")];
}
