// Slash commands: metadata (for /help + the live palette) and pure helpers
// (for model list/switch) kept testable and separate from the UI.
import { MODELS, providerAvailable, findModel, type ProviderId } from "./providers.ts";
import { catalogProvider } from "./accounts/catalog.ts";
import { glyph } from "./ui/theme.ts";
import { fuzzyRank } from "./ui/fuzzy.ts";

// The env var (or generic hint) to set for a provider, for "no key" messages.
const envHint = (p: string): string => ENV_LABEL[p] ?? catalogProvider(p)?.envVars[0] ?? "an API key";

// Commands are grouped so /help reads as a few short lists instead of one
// 26-row wall. `usage` stays short (≤ ~14 chars) so the live palette and help
// columns always line up; the detail lives in `desc`, in plain language.
type Group = "models" | "chat" | "accounts" | "output" | "modes" | "settings" | "other";

export interface CommandMeta {
  name: string;
  usage: string;
  desc: string;
  group: Group;
}

export const COMMANDS: CommandMeta[] = [
  // models & routing — the product's point: pick the right model per task
  { name: "/model", usage: "/model [name]", desc: "list models · /model <name> pins one · /model auto routes per task", group: "models" },
  { name: "/effort", usage: "/effort [tier]", desc: "quality vs speed: fast · balanced · max (used unless a model is pinned)", group: "models" },
  // conversation
  { name: "/clear", usage: "/clear", desc: "start a fresh conversation", group: "chat" },
  { name: "/resume", usage: "/resume [n]", desc: "reopen a past conversation", group: "chat" },
  { name: "/retry", usage: "/retry", desc: "send your last message again", group: "chat" },
  { name: "/compact", usage: "/compact", desc: "shrink the conversation to free up room", group: "chat" },
  { name: "/context", usage: "/context", desc: "see what's loaded and how many tokens it uses", group: "chat" },
  { name: "/memory", usage: "/memory [note]", desc: "show or add facts to remember (or start a line with #)", group: "chat" },
  // accounts & cost
  { name: "/account", usage: "/account", desc: "add, sign in to, switch, or remove model accounts", group: "accounts" },
  { name: "/cost", usage: "/cost", desc: "see what you've spent per account", group: "accounts" },
  // save & copy
  { name: "/copy", usage: "/copy", desc: "copy the last reply to the clipboard", group: "output" },
  { name: "/export", usage: "/export [file]", desc: "save the conversation to a file", group: "output" },
  // modes
  { name: "/plan", usage: "/plan", desc: "plan mode: read-only, no edits (also shift+tab)", group: "modes" },
  { name: "/yolo", usage: "/yolo", desc: "run edits and commands without asking", group: "modes" },
  // look & settings
  { name: "/theme", usage: "/theme [name]", desc: "colors: dark · light · mono · solarized", group: "settings" },
  { name: "/config", usage: "/config", desc: "view or change saved settings", group: "settings" },
  // other
  { name: "/init", usage: "/init", desc: "scan this repo and write a GEARBOX.md guide", group: "other" },
  { name: "/keys", usage: "/keys", desc: "keyboard shortcuts", group: "other" },
  { name: "/help", usage: "/help", desc: "this list", group: "other" },
  { name: "/exit", usage: "/exit", desc: "quit gearbox", group: "other" },
];

// Hidden aliases: still work when typed, but kept out of /help and the palette
// to reduce clutter (/accounts, /login fold into /account; /vim into /config;
// /ghost is an easter egg; /cwd was removed — `/context` shows the directory).
const HIDDEN = new Set(["/accounts", "/login", "/vim", "/ghost", "/cwd"]);

/** Commands whose name starts with the typed draft (for the live palette). */
export function matchCommands(draft: string): CommandMeta[] {
  const q = draft.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  const head = q.split(/\s+/)[0] ?? q;
  if (head === "/") return COMMANDS;
  // Prefer prefix matches; fall back to fuzzy subsequence (e.g. "/cpy" → /copy).
  const prefix = COMMANDS.filter((c) => c.name.startsWith(head));
  if (prefix.length) return prefix;
  return fuzzyRank(COMMANDS, head.slice(1), (c) => c.name.slice(1), 12);
}

const GROUP_TITLES: { id: Group; title: string }[] = [
  { id: "models", title: "models & routing" },
  { id: "chat", title: "conversation" },
  { id: "accounts", title: "accounts & cost" },
  { id: "output", title: "save & copy" },
  { id: "modes", title: "modes" },
  { id: "settings", title: "look & settings" },
  { id: "other", title: "other" },
];

export function helpText(): string {
  const visible = COMMANDS.filter((c) => !HIDDEN.has(c.name));
  const pad = Math.max(...visible.map((c) => c.name.length)) + 2;
  const out: string[] = ["commands · type / to filter, or just say what you want"];
  for (const g of GROUP_TITLES) {
    const items = visible.filter((c) => c.group === g.id);
    if (!items.length) continue;
    out.push("", g.title);
    for (const c of items) out.push(`  ${c.name.padEnd(pad)}${c.desc}`);
  }
  return out.join("\n");
}

/** Render the account list + any importable env creds, marking each provider's default. */
export function formatAccounts(
  accounts: { id: string; label: string; provider: string; exec: string }[],
  defaults: Record<string, string>,
  importable: { provider: string; label: string; envVar: string }[],
): string {
  const lines: string[] = ["accounts"];
  if (!accounts.length) lines.push("  (none yet)");
  for (const a of accounts) {
    const mark = defaults[a.provider] === a.id ? glyph.on : glyph.off;
    const tag = a.exec === "cli" ? " · cli" : "";
    lines.push(`  ${mark} ${a.id.padEnd(20)} ${a.label}${tag}`);
  }
  if (importable.length) {
    lines.push("", "found in your environment — /account import to add:");
    for (const c of importable) lines.push(`  + ${c.label} (${c.envVar})`);
  }
  lines.push(
    "",
    "  /account add <key>   add an API key (auto-detects the provider)",
    "  /account login       sign in to a Claude or ChatGPT subscription",
    "  /account use <id>    switch active account · /account rm <id> to remove",
  );
  return lines.join("\n");
}

/** Render the Context Engine's working-set breakdown (one row per section). */
export function formatContextBreakdown(sections: { name: string; tokens: number }[], contextWindow?: number): string {
  const total = sections.reduce((s, x) => s + x.tokens, 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const rows = sections.map((s) => `  ${s.name.padEnd(10)} ${fmt(s.tokens).padStart(8)}`);
  const pct = contextWindow ? `  (${Math.round((total / contextWindow) * 100)}% of ${fmt(contextWindow)} window)` : "";
  return ["context · what's loaded for the next message (tokens)", ...rows, `  ${"total".padEnd(10)} ${fmt(total).padStart(8)}${pct}`].join("\n");
}

const ENV_LABEL: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/**
 * Model list. Usable models (you have an account for) come first; the long tail
 * of providers you haven't set up collapses to a one-line count, so the list is
 * short and actionable. `/model all` passes showAll to spell them all out.
 */
export function formatModelList(currentId: string | null, showAll = false): string {
  const line = (m: (typeof MODELS)[number]) => `  ${m.id === currentId ? glyph.on : glyph.off} ${m.label.padEnd(18)} ${m.provider}`;
  const usable = MODELS.filter((m) => providerAvailable(m.provider));
  const rest = MODELS.filter((m) => !providerAvailable(m.provider));
  const rows: string[] = ["models · /model <name> pins one · /model auto routes per task"];

  if (usable.length) {
    rows.push("", "ready to use");
    for (const m of usable) rows.push(line(m));
  } else {
    rows.push("", "no accounts yet — /account to add one");
  }

  if (showAll && rest.length) {
    rows.push("", "needs an account");
    for (const m of rest) rows.push(`  ${glyph.off} ${m.label.padEnd(18)} ${m.provider}`);
  } else if (rest.length) {
    rows.push("", `  + ${rest.length} more once you add a key — /model all to list · /account to add one`);
  }
  return rows.join("\n");
}

export interface SwitchResult {
  ok: boolean;
  modelId?: string;
  message: string;
}

// Fuzzy: match by substring on label or id, so "haiku" finds "claude-haiku-4-5".
// Handles none / no-key / ambiguous / exact gracefully.
export function resolveModelSwitch(query: string): SwitchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { ok: false, message: "usage: /model <name>" };

  const matches = MODELS.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  if (matches.length === 0) return { ok: false, message: `no model matching “${query}” — /model to list` };

  const exact = matches.find((m) => m.label.toLowerCase() === q || m.id.toLowerCase() === q);
  const available = matches.filter((m) => providerAvailable(m.provider));

  if (exact) {
    if (!providerAvailable(exact.provider)) return { ok: false, message: `${exact.label}: no ${exact.provider} account yet — /account add ${exact.provider} <key> or set ${envHint(exact.provider)}` };
    return { ok: true, modelId: exact.id, message: `model → ${exact.label}` };
  }
  if (available.length === 0) {
    const m = matches[0]!;
    return { ok: false, message: `“${query}” matches ${m.label} but no account for ${m.provider} — /accounts add ${m.provider} <key> or set ${envHint(m.provider)}` };
  }
  if (available.length > 1) {
    return { ok: false, message: `“${query}” matches ${available.map((m) => m.label).join(", ")} — be more specific` };
  }
  const m = available[0]!;
  return { ok: true, modelId: m.id, message: `model → ${m.label}` };
}
