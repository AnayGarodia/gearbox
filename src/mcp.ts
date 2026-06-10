// MCP client layer: connects configured Model Context Protocol servers
// (stdio transport) and exposes their tools to the agent loop as AI SDK tools
// named `mcp_<server>_<tool>`.
//
// Config is read from three files, later entries overriding earlier ones by
// server name:
//   1. ~/.gearbox/mcp.json          (global)
//   2. <cwd>/.mcp.json              (compat — the de-facto cross-tool location)
//   3. <cwd>/.gearbox/mcp.json      (project; wins)
//
// Trust model: an MCP server is an arbitrary subprocess the user pointed us
// at, so it never inherits our provider credentials (mcpSafeEnv), and any
// tool that doesn't declare itself read-only is gated behind the same
// permission prompt as run_shell. Connection failures are silent by design —
// a broken server must never stop Gearbox from starting.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { tool, jsonSchema } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OnEvent } from "./agent/events.ts";
import { requestPermission } from "./permission.ts";
import { CATALOG } from "./accounts/catalog.ts";

/** One server entry as written in an mcp.json file. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

/** A whole config file. Both `mcpServers` (Claude/Cursor convention) and `servers` are accepted; `mcpServers` wins when both exist. We always write `mcpServers`. */
export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
  servers?: Record<string, McpServerConfig>;
}

type Connected = { name: string; config: McpServerConfig; client: Client; tools: any[] };
type McpScope = "global" | "project";

// Lazy connection singleton: servers are spawned once, on the first turn that
// needs tools, and shared for the rest of the process. reloadMcpConnections()
// nulls it so the next call reconnects with fresh config (after /mcp add|rm);
// the old subprocesses are left to die with the process rather than torn down
// mid-call.
let connectedPromise: Promise<Connected[]> | null = null;

const HOME = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");

// A missing or malformed config file is treated as empty: hand-edited JSON
// must never crash startup.
function readConfigFile(path: string): McpConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeConfigFile(path: string, config: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// ${VAR} interpolation so config files can reference secrets without
// containing them (e.g. "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }).
// An unset variable expands to "" rather than leaking the placeholder.
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

// Merge the three config sources (global < .mcp.json compat < project) into
// the effective server set, dropping disabled/commandless entries and
// expanding ${VAR} in command, args, cwd, and env values. A server with no
// explicit cwd runs in the project directory, not wherever gearbox launched.
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

// Provider APIs constrain tool names (OpenAI: ^[a-zA-Z0-9_-]{1,64}$ is the
// strictest we route to), so the prefixed name is sanitized and capped at 64.
// Truncation can in principle collide two very long names; the last writer
// wins in the toolset map.
function safeToolName(server: string, name: string): string {
  return `mcp_${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// An MCP server is an untrusted subprocess (often third-party / npx-fetched),
// so it must NOT inherit our LLM provider credentials — mirrors the CLI
// backend's KEYS_TO_STRIP. We strip every catalog provider env var plus the
// common secret-bearing names, then the server's own declared `env` re-adds
// exactly what it legitimately needs (so a server that wants e.g. GITHUB_TOKEN
// still gets it, but only by explicit opt-in). Pure + exported for testing.
const MCP_SECRET_PATTERN = /(API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|SECRET|PASSWORD|CREDENTIAL|_TOKEN$|^GH_TOKEN$|^GITHUB_TOKEN$|SESSION_TOKEN)/i;
export function mcpSafeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const strip = new Set<string>();
  for (const p of CATALOG) for (const v of p.envVars) strip.add(v);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (strip.has(k) || MCP_SECRET_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Spawn and handshake every configured server concurrently. Each server is
// independent: one hanging or crashing only loses its own tools (the
// listTools timeout bounds the boot cost of a wedged server at 10s, paid in
// parallel with the others).
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
        // Strip our provider credentials before handing env to the untrusted
        // subprocess; a secret reaches the server only if the user explicitly
        // names it in the server's config.env (which also wins on conflicts).
        env: { ...mcpSafeEnv(process.env), ...(config.env ?? {}) } as Record<string, string>,
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

export function reloadMcpConnections(): void {
  connectedPromise = null;
}

// Flatten an MCP result's content parts into plain text for the model.
// Image data is summarized, not inlined — base64 blobs would blow the
// context for no benefit since tool results are text-only today.
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

/** One line per exposed tool — backs `/mcp tools` and `gearbox mcp tools`. Connects on first use. */
export async function mcpToolSummary(): Promise<string> {
  const rows = await connected();
  if (!rows.length) return "No MCP servers connected. Configure ~/.gearbox/mcp.json or .gearbox/mcp.json.";
  return rows.flatMap((s) => s.tools.map((t) => `${safeToolName(s.name, t.name).padEnd(34)} ${t.description ?? ""}`)).join("\n");
}

export function mcpConfigPath(scope: McpScope = "project", cwd = process.cwd()): string {
  return scope === "global" ? join(HOME(), "mcp.json") : join(cwd, ".gearbox", "mcp.json");
}

// Raw per-file listing for `/mcp` — unlike normalizeConfig this keeps
// duplicates and disabled entries so the user can see exactly what each file
// declares and which scope a name comes from.
export function configuredMcpServers(cwd = process.cwd()): Array<{ name: string; scope: McpScope | "compat"; config: McpServerConfig }> {
  const paths: Array<{ scope: McpScope | "compat"; path: string }> = [
    { scope: "global", path: join(HOME(), "mcp.json") },
    { scope: "compat", path: join(cwd, ".mcp.json") },
    { scope: "project", path: join(cwd, ".gearbox", "mcp.json") },
  ];
  const rows: Array<{ name: string; scope: McpScope | "compat"; config: McpServerConfig }> = [];
  for (const p of paths) {
    const file = readConfigFile(p.path);
    for (const [name, config] of Object.entries(file.mcpServers ?? file.servers ?? {})) {
      if (!config?.command) continue;
      rows.push({ name, scope: p.scope, config });
    }
  }
  return rows;
}

export function formatMcpConfigList(cwd = process.cwd()): string {
  const rows = configuredMcpServers(cwd);
  if (!rows.length) {
    return [
      "MCP servers",
      "  none configured",
      "",
      "Add one:",
      "  /mcp add github npx -y @modelcontextprotocol/server-github",
      "  /mcp add --global linear npx -y @modelcontextprotocol/server-linear",
    ].join("\n");
  }
  return [
    "MCP servers",
    ...rows.map((r) => {
      const args = r.config.args?.length ? " " + r.config.args.join(" ") : "";
      const off = r.config.disabled ? " · disabled" : "";
      return `  ${r.name.padEnd(18)} ${r.scope.padEnd(7)} ${r.config.command}${args}${off}`;
    }),
    "",
    "Tools: /mcp tools",
    "Remove: /mcp remove <name>",
  ].join("\n");
}

// Minimal shell-style tokenizer for `/mcp add <name> <command line>`:
// handles single/double quotes and backslash escapes, nothing else (no
// globbing, no $expansion — expandEnv runs later, at spawn time). Deliberately
// dependency-free; we never hand this string to a real shell.
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let esc = false;
  for (const ch of input) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// Server names are embedded in tool names and config keys, so they are
// slugified to the same character set safeToolName allows.
function cleanServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Persist a server to the project (default) or global config and drop the connection cache so it's live next turn. */
export function addMcpServer(name: string, command: string, args: string[] = [], opts: { scope?: McpScope; cwd?: string } = {}): string {
  const serverName = cleanServerName(name);
  if (!serverName || !command) throw new Error("usage: /mcp add <name> <command> [args...]");
  const path = mcpConfigPath(opts.scope ?? "project", opts.cwd ?? process.cwd());
  const file = readConfigFile(path);
  const servers = { ...(file.mcpServers ?? file.servers ?? {}) };
  servers[serverName] = { command, args };
  writeConfigFile(path, { mcpServers: servers });
  reloadMcpConnections();
  return `connected ${serverName} (${opts.scope ?? "project"})`;
}

/** Remove a server by name; without an explicit scope, project config is tried before global (first hit wins). Never touches .mcp.json — that file belongs to other tools too. */
export function removeMcpServer(name: string, opts: { scope?: McpScope; cwd?: string } = {}): string {
  const serverName = cleanServerName(name);
  const scopes: McpScope[] = opts.scope ? [opts.scope] : ["project", "global"];
  for (const scope of scopes) {
    const path = mcpConfigPath(scope, opts.cwd ?? process.cwd());
    const file = readConfigFile(path);
    const servers = { ...(file.mcpServers ?? file.servers ?? {}) };
    if (!(serverName in servers)) continue;
    delete servers[serverName];
    writeConfigFile(path, { mcpServers: servers });
    reloadMcpConnections();
    return `removed ${serverName} (${scope})`;
  }
  return `no MCP server named ${serverName}`;
}

// Wrap every remote tool as an AI SDK tool for the agent loop. Trust the
// server's annotations only in the safe direction: `readOnly` (plan mode)
// excludes anything not POSITIVELY marked read-only, and execution treats an
// unannotated tool as risky — so a server that declares nothing gets the
// permission prompt, never a free pass.
export async function mcpTools(onEvent?: OnEvent, readOnly = false): Promise<Record<string, any>> {
  const rows = await connected();
  const out: Record<string, any> = {};
  for (const server of rows) {
    for (const remote of server.tools) {
      if (readOnly && remote.annotations?.readOnlyHint !== true) continue;
      const name = safeToolName(server.name, remote.name);
      out[name] = tool({
        description: `[MCP:${server.name}] ${remote.description ?? remote.title ?? remote.name}`,
        // Some servers omit inputSchema; the AI SDK requires one.
        inputSchema: jsonSchema((remote.inputSchema ?? { type: "object", properties: {} }) as any),
        execute: async (input: any) => {
          const risky = remote.annotations?.destructiveHint || remote.annotations?.openWorldHint || !remote.annotations?.readOnlyHint;
          // kind:"shell" on purpose — MCP calls ride the shell permission lane,
          // so session grants, project rules, and yolo apply uniformly.
          if (risky && !(await requestPermission({ kind: "shell", title: "Run MCP tool", detail: `${server.name}.${remote.name}` }))) {
            throw new Error("Permission denied by the user — they declined this MCP tool.");
          }
          onEvent?.({ type: "phase", label: "using MCP", detail: `${server.name}.${remote.name}`, state: "running" });
          try {
            const result = await server.client.callTool({ name: remote.name, arguments: input ?? {} }, undefined, { timeout: 120_000 });
            return formatMcpResult(result);
          } catch (e: any) {
            // SDK exceptions can be raw objects — surface a readable message to the model.
            throw new Error(e?.message ?? "MCP call failed");
          }
        },
      });
    }
  }
  return out;
}

/** Every path we read, in merge order — backs `gearbox mcp paths`. */
export function mcpConfigPaths(cwd = process.cwd()): string[] {
  return [join(HOME(), "mcp.json"), join(cwd, ".mcp.json"), join(cwd, ".gearbox", "mcp.json")];
}
