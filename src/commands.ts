// Slash commands: metadata (for /help + the live palette) and pure helpers
// (for model list/switch) kept testable and separate from the UI.
import { MODELS, providerAvailable, findModel, type ProviderId } from "./providers.ts";
import { glyph } from "./ui/theme.ts";

export interface CommandMeta {
  name: string;
  usage: string;
  desc: string;
}

export const COMMANDS: CommandMeta[] = [
  { name: "/help", usage: "/help", desc: "show commands" },
  { name: "/model", usage: "/model [name|auto]", desc: "show models, pin one, or /model auto to route per task" },
  { name: "/plan", usage: "/plan", desc: "toggle read-only plan mode (or shift+tab)" },
  { name: "/init", usage: "/init", desc: "survey the repo and write GEARBOX.md" },
  { name: "/memory", usage: "/memory [note]", desc: "show remembered facts, or add one (also: #note)" },
  { name: "/context", usage: "/context", desc: "show the working-set breakdown (tokens per section)" },
  { name: "/compact", usage: "/compact", desc: "summarize older turns now to free up context" },
  { name: "/ghost", usage: "/ghost [mood]", desc: "change Boo's mood (base/mint/pink/golden/shades)" },
  { name: "/yolo", usage: "/yolo", desc: "toggle yolo mode (run writes/edits/shell without asking)" },
  { name: "/clear", usage: "/clear", desc: "clear the conversation (starts a new session)" },
  { name: "/resume", usage: "/resume [n]", desc: "list saved sessions, or resume one" },
  { name: "/retry", usage: "/retry", desc: "re-run your last prompt" },
  { name: "/cwd", usage: "/cwd", desc: "show the working directory" },
  { name: "/exit", usage: "/exit", desc: "quit gearbox" },
];

/** Commands whose name starts with the typed draft (for the live palette). */
export function matchCommands(draft: string): CommandMeta[] {
  const q = draft.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  const head = q.split(/\s+/)[0] ?? q;
  return COMMANDS.filter((c) => c.name.startsWith(head));
}

export function helpText(): string {
  const rows = COMMANDS.map((c) => `  ${c.usage.padEnd(16)} ${c.desc}`);
  return ["commands", ...rows].join("\n");
}

/** Render the Context Engine's working-set breakdown (one row per section). */
export function formatContextBreakdown(sections: { name: string; tokens: number }[], contextWindow?: number): string {
  const total = sections.reduce((s, x) => s + x.tokens, 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const rows = sections.map((s) => `  ${s.name.padEnd(10)} ${fmt(s.tokens).padStart(8)}`);
  const pct = contextWindow ? `  (${Math.round((total / contextWindow) * 100)}% of ${fmt(contextWindow)} window)` : "";
  return ["context · working set sent this turn", ...rows, `  ${"total".padEnd(10)} ${fmt(total).padStart(8)}${pct}`].join("\n");
}

const ENV_LABEL: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** A nicely-aligned model list; marks the current model and which lack a key. */
export function formatModelList(currentId: string | null): string {
  const rows = MODELS.map((m) => {
    const mark = m.id === currentId ? glyph.on : glyph.off;
    const avail = providerAvailable(m.provider) ? m.provider : `${m.provider} · no key`;
    return `  ${mark} ${m.label.padEnd(16)} ${avail}`;
  });
  return ["models · /model <name> to switch", ...rows].join("\n");
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
    if (!providerAvailable(exact.provider)) return { ok: false, message: `${exact.label}: no key for ${exact.provider} — set ${ENV_LABEL[exact.provider]}` };
    return { ok: true, modelId: exact.id, message: `model → ${exact.label}` };
  }
  if (available.length === 0) {
    const m = matches[0]!;
    return { ok: false, message: `“${query}” matches ${m.label} but no key for ${m.provider} — set ${ENV_LABEL[m.provider]}` };
  }
  if (available.length > 1) {
    return { ok: false, message: `“${query}” matches ${available.map((m) => m.label).join(", ")} — be more specific` };
  }
  const m = available[0]!;
  return { ok: true, modelId: m.id, message: `model → ${m.label}` };
}
