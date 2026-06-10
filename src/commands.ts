// Slash commands: metadata (for /help + the live palette) and pure helpers
// (for model list/switch) kept testable and separate from the UI.
import { modelRegistry, providerAvailable, findModel, type ProviderId } from "./providers.ts";
import { catalogProvider } from "./accounts/catalog.ts";
import { glyph } from "./ui/theme.ts";
import { fuzzyRank } from "./ui/fuzzy.ts";
import type { ContextView } from "./ui/types.ts";
import type { HealthState } from "./accounts/types.ts";
import type { Scorecard } from "./model/selector.ts";

// The env var (or generic hint) to set for a provider, for "no key" messages.
const envHint = (p: string): string => ENV_LABEL[p] ?? catalogProvider(p)?.envVars[0] ?? "an API key";

/** Map a HealthState to a short human-readable badge string. */
export function badgeFor(s: HealthState | undefined): string {
  switch (s) {
    case "ok": return "✓ ready";
    case "expired": return "⚠ expired";
    case "invalid": return "✗ invalid";
    case "rate-limited": return "⏳ limited";
    case "no-credit": return "✗ no credit";
    default: return "— unknown";
  }
}

// Commands are grouped so /help reads as a few short lists instead of one
// 26-row wall. `usage` stays short (≤ ~14 chars) so the live palette and help
// columns always line up; the detail lives in `desc`, in plain language.
type Group = "models" | "chat" | "git" | "accounts" | "output" | "modes" | "settings" | "other";

export interface CommandMeta {
  name: string;
  usage: string;
  desc: string;
  group: Group;
}

export const COMMANDS: CommandMeta[] = [
  // models & routing · the product's point: pick the right model per task
  { name: "/model", usage: "/model [name]", desc: "list models · /model <name> pins one · /model auto routes per task", group: "models" },
  { name: "/effort", usage: "/effort [level]", desc: "set the active model's reasoning level, e.g. low · high · xhigh · max", group: "models" },
  { name: "/prefer", usage: "/prefer kind model", desc: "remember a confirmed model preference for a task type", group: "models" },
  { name: "/why", usage: "/why", desc: "show the routing scorecard: every candidate scored, and why this one won", group: "models" },
  { name: "/agents", usage: "/agents", desc: "list agents · run one with @<name> <task> (scout is built in) · add .gearbox/agents/*.md", group: "models" },
  // conversation
  { name: "/clear", usage: "/clear", desc: "start a fresh conversation", group: "chat" },
  { name: "/resume", usage: "/resume [n]", desc: "reopen a past conversation", group: "chat" },
  { name: "/retry", usage: "/retry", desc: "send your last message again", group: "chat" },
  { name: "/undo", usage: "/undo", desc: "revert the last turn's file changes (conversation unchanged)", group: "chat" },
  { name: "/diff", usage: "/diff", desc: "show all file changes made this session", group: "chat" },
  { name: "/compact", usage: "/compact", desc: "shrink the conversation to free up room", group: "chat" },
  { name: "/context", usage: "/context", desc: "see what's loaded and how many tokens it uses", group: "chat" },
  { name: "/ask", usage: "/ask <q>", desc: "ask about Gearbox itself · answered from its own docs", group: "chat" },
  { name: "/memory", usage: "/memory [note]", desc: "show or add facts to remember (or start a line with #)", group: "chat" },
  // git
  { name: "/commit", usage: "/commit [-a|msg]", desc: "commit staged changes with a generated message (confirm before it runs) · -a stages everything first", group: "git" },
  { name: "/push", usage: "/push", desc: "push the current branch (sets upstream on first push) · output streams live", group: "git" },
  { name: "/pr", usage: "/pr [create|list|view|diff]", desc: "GitHub PRs via gh: create with a generated title/body, list, view, or read a diff", group: "git" },
  { name: "/worktree", usage: "/worktree [add|list|use|rm]", desc: "work on a branch in an isolated worktree · use switches the session into it", group: "git" },
  { name: "/checkpoint", usage: "/checkpoint [name|list|restore|rm]", desc: "snapshot the whole working tree (untracked too) · restore rolls back to it", group: "git" },
  // accounts & cost
  { name: "/account", usage: "/account", desc: "list accounts; /account <name> switches, /account login <name> re-auths, /account add adds one", group: "accounts" },
  { name: "/onboard", usage: "/onboard", desc: "first-run setup; provider list and import/add commands", group: "accounts" },
  { name: "/mcp", usage: "/mcp", desc: "list or connect MCP servers: /mcp add <name> <command> [args]", group: "accounts" },
  { name: "/usage", usage: "/usage", desc: "live usage: limits, spend & context (fullscreen: toggles a strip)", group: "accounts" },
  { name: "/doctor", usage: "/doctor", desc: "live-check every account with one tiny real call · names the fix for each failure", group: "accounts" },
  { name: "/budget", usage: "/budget <provider> <amount> [monthly|total]", desc: "set a spend budget so routing can estimate remaining credit and preserve it", group: "accounts" },
  { name: "/cap", usage: "/cap <session|daily|monthly|total> <amount>", desc: "hard spend ceiling · turns refuse once reached (/cap off to clear)", group: "accounts" },
  // save & copy
  { name: "/copy", usage: "/copy", desc: "copy the last reply to the clipboard", group: "output" },
  { name: "/export", usage: "/export [file]", desc: "save the conversation to a file", group: "output" },
  // modes
  { name: "/plan", usage: "/plan", desc: "plan mode: read-only, no edits (also shift+tab)", group: "modes" },
  { name: "/yolo", usage: "/yolo", desc: "run edits and commands without asking", group: "modes" },
  { name: "/verify", usage: "/verify [off|auto|test]", desc: "checks after edits + auto-fix to green · /verify test writes a characterization test when none exist", group: "modes" },
  // settings
  { name: "/config", usage: "/config", desc: "view or change saved settings", group: "settings" },
  { name: "/theme", usage: "/theme [name]", desc: "palette gallery with live preview · dark · light · gruvbox · catppuccin · solarized · contrast", group: "settings" },
  // other
  { name: "/init", usage: "/init", desc: "scan this repo and write a GEARBOX.md guide", group: "other" },
  { name: "/keys", usage: "/keys", desc: "keyboard shortcuts", group: "other" },
  { name: "/help", usage: "/help", desc: "this list", group: "other" },
  { name: "/exit", usage: "/exit", desc: "quit gearbox", group: "other" },
];

// Hidden aliases: still work when typed, but kept out of /help and the palette
// to reduce clutter (/accounts, /login fold into /account; /vim into /config;
// /ghost is an easter egg; /cwd was removed · `/context` shows the directory).
const HIDDEN = new Set(["/accounts", "/login", "/vim", "/ghost", "/cwd", "/cost"]);

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

// Command-NAME completions, but ONLY while the name is still being typed. Once an
// argument follows (`/ask how do I…`, `/prefer code haiku`), the name is settled,
// so we return none — otherwise the lone name-match keeps the palette "active",
// which lets it swallow ↑/↓ (capping the index at `% 1` → it never moves) and
// blocks prompt-history navigation, and clutters the dropdown with a command
// you've already finished typing. Commands with real argument pickers (/model,
// /account, /effort, /resume) surface their rows through commandPickerRows, not
// here, so this gate doesn't affect them.
export function commandNameMatches(draft: string): CommandMeta[] {
  if (!draft.startsWith("/")) return [];
  if (/^\/\S+\s/.test(draft.trimStart())) return []; // a space after the name → typing args
  return matchCommands(draft);
}

const GROUP_TITLES: { id: Group; title: string }[] = [
  { id: "models", title: "models & routing" },
  { id: "chat", title: "conversation" },
  { id: "git", title: "git" },
  { id: "accounts", title: "accounts & cost" },
  { id: "output", title: "save & copy" },
  { id: "modes", title: "modes" },
  { id: "settings", title: "settings" },
  { id: "other", title: "other" },
];

// The account-add reference · single source of truth, shown by `/account add`
// and fed into the /ask docs corpus so "how do I add X" answers are exact.
export const ACCOUNT_ADD_HELP =
  "add an account:\n" +
  "  /account add claude          Claude subscription (Pro/Max)\n" +
  "  /account add claude <name>   a 2nd Claude account, e.g. /account add claude work\n" +
  "  /account add codex           ChatGPT subscription (Plus/Pro)\n" +
  "  /account add codex <name>    a 2nd ChatGPT account, e.g. /account add codex work\n" +
  "  /account add azure <foundry-endpoint> <api-key>            Azure AI Foundry (pass the full https:// endpoint)\n" +
  "  /account add azure <resource-name> <api-key> [api-version] Azure OpenAI (pass the bare resource name)\n" +
  "  /account add bedrock <access-key-id> <secret> <region>     Amazon Bedrock\n" +
  "  /account add vertex <project> <location>                   Google Vertex AI (gcloud ADC; paste a service-account JSON via the wizard)\n" +
  "  /account add openai-compat <name> <base-url> <api-key> <model> [model...]\n" +
  "  /account add <paste>         paste any key / AWS block / service-account JSON / endpoint (auto-detected)\n" +
  "  /account add <provider> <api-key>   e.g. anthropic, openai, openrouter\n" +
  "After adding, /account refresh discovers the models the account can actually serve.";

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

// The bare account name, no type suffix · e.g. "Claude", "Claude (work)",
// "ChatGPT", "Anthropic", "OpenRouter". Use under a group header that already
// states the type; use accountLabel() when the type needs to be inline.
export function accountName(a: { id: string; provider: string; exec: string; auth?: any }): string {
  if (a.exec === "cli") {
    const bin = a.auth?.binary;
    const base = bin === "codex" ? "ChatGPT" : "Claude";
    const named = a.id.match(/-cli-(.+)$/); // additional account: claude-cli-<name>
    return named ? `${base} (${named[1]})` : base;
  }
  return catalogProvider(a.provider)?.label ?? a.provider;
}

export function accountSlug(a: { id: string; provider: string; exec: string; auth?: any; slug?: string }): string {
  if (a.slug) return a.slug;
  return accountName(a)
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A plain-English label with the type suffix · e.g. "Claude · subscription",
// "Claude (work) · subscription", "Anthropic · API key".
export function accountLabel(a: { id: string; provider: string; exec: string; auth?: any }): string {
  return `${accountName(a)} · ${a.exec === "cli" ? "subscription" : "API key"}`;
}

/**
 * Account list · you switch/remove by NAME (slug), never a number or an id. The
 * active subscription (if any) is marked; otherwise API keys auto-route.
 */
export function formatAccounts(
  accounts: { id: string; label: string; provider: string; exec: string; auth?: any }[],
  activeCliId: string | null,
  importable: { provider: string; label: string; envVar: string }[],
  statuses: Record<string, { signedIn?: boolean; detail?: string; duplicateOf?: string }> = {},
): string {
  const lines: string[] = ["your accounts"];
  if (!accounts.length) {
    lines.push("  (none yet)");
  } else {
    const active = activeCliId ? accounts.find((a) => a.id === activeCliId) : null;
    if (active) lines.push(`  current: ${accountLabel(active)}`);
    else lines.push("  current: API routing");
    lines.push("");
    accounts.forEach((a, i) => {
      const mark = a.id === activeCliId ? glyph.on : " ";
      const st = statuses[a.id];
      const status =
        a.id === activeCliId ? "active" :
        st?.duplicateOf ? `same login as ${st.duplicateOf}` :
        st?.signedIn === false ? "not signed in" :
        st?.signedIn === true ? "signed in" :
        a.exec === "cli" ? "not checked" :
        "ready";
      const alias = accountSlug(a);
      lines.push(`  ${mark} ${accountLabel(a).padEnd(34)} ${status}`);
      lines.push(`      use /account ${alias}`);
      if (st?.detail && st.signedIn) lines.push(`      ${st.detail}`);
    });
    if (!activeCliId) lines.push("", "  no subscription active · your API keys auto-route per task");
  }
  if (importable.length) {
    lines.push("", "found in your environment · /account import to add:");
    for (const c of importable) lines.push(`  + ${c.label} (${c.envVar})`);
  }
  lines.push(
    "",
    "  switch: /account <name>",
    "  add:    /account add codex [name]  ·  /account add claude [name]  ·  /account add <api-key>",
    accounts.length ? "  remove: /account remove <name>" : "",
    accounts.length ? "  refresh models: /account refresh" : "",
  );
  return lines.filter(Boolean).join("\n");
}

/** Build the structured /context card: one bar per working-set section (sized
 *  against the largest section) plus a window-fill percentage. */
export function buildContextView(sections: { name: string; tokens: number }[], contextWindow?: number, cwd = ""): ContextView {
  const total = sections.reduce((s, x) => s + x.tokens, 0);
  const max = Math.max(1, ...sections.map((s) => s.tokens));
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const rows = sections.map((s) => ({ label: s.name, display: fmt(s.tokens), frac: s.tokens / max }));
  const labelPad = Math.max("total".length, ...rows.map((r) => r.label.length));
  const valuePad = Math.max(fmt(total).length, ...rows.map((r) => r.display.length));
  return {
    rows,
    total: fmt(total),
    windowPct: contextWindow ? Math.round((total / contextWindow) * 100) : undefined,
    windowLabel: contextWindow ? fmt(contextWindow) : undefined,
    cwd,
    labelPad,
    valuePad,
  };
}

const ENV_LABEL: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

// Render the routing scorecard (`/why`) as a monospace table the UI prints. Pure
// + shared by both renderers (fullscreen lines + inline Transcript), so the
// columns line up identically. `tone` maps to a color at the render layer.
export interface ScorecardLine {
  text: string;
  tone: "title" | "colhead" | "chosen" | "row" | "dim" | "note";
}

const provAbbrev = (src: string): string => (src === "measured" ? "meas" : src === "researched" ? "rsch" : "seed");

export function scorecardRows(card: Scorecard): ScorecardLine[] {
  const out: ScorecardLine[] = [];
  out.push({ text: `why · ${card.kind} task · quality bar ${card.bar.toFixed(2)}`, tone: "title" });
  if (card.prompt) out.push({ text: `"${card.prompt.length > 60 ? card.prompt.slice(0, 57) + "…" : card.prompt}"`, tone: "note" });
  if (!card.entries.length) {
    out.push({ text: card.note ?? "no candidates", tone: "note" });
    return out;
  }
  const entries = card.entries.slice(0, 8);
  const labelW = Math.min(20, Math.max(5, ...entries.map((e) => e.label.length)));
  const qcol = (e: typeof entries[number]) => `${e.quality.toFixed(2)} ${provAbbrev(e.qualitySrc)}`;
  const leftcol = (e: typeof entries[number]) => e.headroomText ?? e.balanceText ?? "—";
  const lw = Math.max(4, ...entries.map((e) => leftcol(e).length));
  const row = (label: string, q: string, cost: string, left: string, score: string, verdict: string) =>
    `${label.padEnd(labelW).slice(0, labelW)}  ${q.padEnd(9)}  ${cost.padStart(7)}  ${left.padEnd(lw)}  ${score.padStart(5)}  ${verdict}`;
  out.push({ text: row("model", "quality", "$/Mtok", "left", "score", "verdict"), tone: "colhead" });
  for (const e of entries) {
    const score = e.verdict === "below bar" ? "—" : e.score.toFixed(2);
    out.push({
      text: row(e.label, qcol(e), `$${e.estCostPerMtok.toFixed(2)}`, leftcol(e), score, e.verdict + (e.chosen ? "  ◀" : "") + (e.priorNote ? `  · ${e.priorNote}` : "")),
      tone: e.chosen ? "chosen" : e.verdict === "below bar" ? "dim" : "row",
    });
  }
  if (card.entries.length > entries.length) out.push({ text: `…and ${card.entries.length - entries.length} more`, tone: "note" });
  return out;
}

/**
 * Model list. Usable models (you have an account for) come first; the long tail
 * of providers you haven't set up collapses to a one-line count, so the list is
 * short and actionable. `/model all` passes showAll to spell them all out.
 */
export function formatModelList(currentId: string | null, showAll = false): string {
  const MODELS = modelRegistry();
  const line = (m: (typeof MODELS)[number]) => `  ${m.id === currentId ? glyph.on : glyph.off} ${m.label.padEnd(18)} ${m.provider}`;
  const usable = MODELS.filter((m) => providerAvailable(m.provider));
  const rest = MODELS.filter((m) => !providerAvailable(m.provider));
  const rows: string[] = ["models · /model <name> pins one · /model auto routes per task"];

  if (usable.length) {
    rows.push("", "ready to use");
    // Cap each provider's list · a discovered account (e.g. Azure Foundry) can
    // serve 100+ models, which would bury everything else. `/model all` or a
    // fuzzy `/model <name>` still reaches the rest.
    const CAP = 8;
    const shown = new Map<string, number>();
    let hidden = 0;
    for (const m of usable) {
      const n = shown.get(m.provider) ?? 0;
      if (!showAll && n >= CAP) { hidden++; continue; }
      shown.set(m.provider, n + 1);
      rows.push(line(m));
    }
    if (hidden) rows.push(`  + ${hidden} more on your accounts · /model all to list · /model <name> to pick`);
  } else {
    rows.push("", "no accounts yet · /account to add one");
  }

  if (showAll && rest.length) {
    rows.push("", "needs an account");
    for (const m of rest) rows.push(`  ${glyph.off} ${m.label.padEnd(18)} ${m.provider}`);
  } else if (rest.length) {
    rows.push("", `  + ${rest.length} more once you add a key · /model all to list · /account to add one`);
  }
  return rows.join("\n");
}

export interface SwitchResult {
  ok: boolean;
  modelId?: string;
  message: string;
}

// Recognized model family words — so an in-prompt directive ("use opus", "with
// haiku") is detected without false-matching ordinary words ("use the X library").
const MODEL_ALIASES =
  /\b(opus|sonnet|haiku|gpt[-\d.]*|o[34](?:-\w+)?|gemini[-\d.a-z]*|flash[-\d.a-z]*|deepseek[-\w.]*|nova[-\w.]*|llama[-\w.\d]*|grok[-\w.\d]*|qwen[-\w.\d]*|mistral[-\w.\d]*|kimi[-\w.\d]*|minimax[-\w.\d]*)\b/i;

/**
 * Detect an EXPLICIT model directive in a free-text prompt ("use opus to …",
 * "with haiku", "run sonnet") and resolve it to a model id, or null. Strict on
 * purpose: the word after use/with/via/on must be a known model family alias AND
 * resolve to exactly one available model, so ordinary prose never pins a model.
 * This is the seam the router was missing — "use opus" used to be invisible to it.
 */
export function modelDirectiveIn(prompt: string): string | null {
  const m = prompt.match(/\b(?:use|using|with|via|run(?:\s+with)?|route(?:\s+to)?|on)\s+(?:the\s+)?([a-z0-9][a-z0-9.\-]*(?:\s+[a-z0-9][a-z0-9.\-]*)?)/i);
  if (!m) return null;
  const cand = m[1]!.trim();
  const alias = cand.match(MODEL_ALIASES)?.[0];
  if (!alias) return null; // the token isn't a model name — not a directive
  for (const q of [cand, alias]) {
    const r = resolveModelSwitch(q);
    if (r.ok && r.modelId) return r.modelId;
  }
  return null;
}

// Fuzzy: match by substring on label or id, so "haiku" finds "claude-haiku-4-5".
// Handles none / no-key / ambiguous / exact gracefully.
export function resolveModelSwitch(query: string): SwitchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { ok: false, message: "usage: /model <name>" };

  const MODELS = modelRegistry();
  let matches = MODELS.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  if (matches.length === 0) return { ok: false, message: `no model matching "${query}" · /model to list` };
  // The models.dev overlay (routable:false) must never make a fuzzy query
  // ambiguous against curated/discovered models — "haiku" stays the curated
  // haiku even with five catalog Haikus around. Overlay entries only compete
  // when nothing first-class matched (so an exact catalog id still pins).
  const firstClass = matches.filter((m) => m.routable !== false);
  if (firstClass.length > 0) matches = firstClass;

  const exacts = matches.filter((m) => m.label.toLowerCase() === q || m.id.toLowerCase() === q);
  const available = matches.filter((m) => providerAvailable(m.provider));
  const exactAvailable = exacts.filter((m) => providerAvailable(m.provider));

  // Prefer an exact match on an available provider over one that has no account yet.
  // This lets "DeepSeek-V4-Pro" resolve to an azure-foundry deployment even when
  // the native deepseek provider also has a same-named curated entry but no key.
  if (exactAvailable.length === 1) return { ok: true, modelId: exactAvailable[0]!.id, message: `model → ${exactAvailable[0]!.label}` };
  if (exactAvailable.length > 1) return { ok: false, message: `"${query}" matches ${exactAvailable.map((m) => m.label).join(", ")} · be more specific` };
  if (exacts.length > 0) {
    const m = exacts[0]!;
    return { ok: false, message: `${m.label}: no ${m.provider} account yet · /account add ${m.provider} <key> or set ${envHint(m.provider)}` };
  }

  if (available.length === 0) {
    const m = matches[0]!;
    return { ok: false, message: `"${query}" matches ${m.label} but no account for ${m.provider} · /accounts add ${m.provider} <key> or set ${envHint(m.provider)}` };
  }
  if (available.length > 1) {
    return { ok: false, message: `"${query}" matches ${available.map((m) => m.label).join(", ")} · be more specific` };
  }
  const m = available[0]!;
  return { ok: true, modelId: m.id, message: `model → ${m.label}` };
}
