// Session persistence. Conversations are saved per-project so they survive across
// runs (--continue / /resume), and prompt history persists too. The record is
// deliberately ROUTING-READY: each turn stores the model used + token usage +
// timestamp, so the future cost engine and router have real data to learn from,
// and the message log stays provider-neutral (AI SDK ModelMessage). Nothing here
// assumes a single model.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelMessage } from "ai";
import type { Item } from "./ui/types.ts";

// GEARBOX_HOME overrides the data dir (defaults to ~/.gearbox); handy for tests
// and for relocating state.
const root = () => join(process.env.GEARBOX_HOME || join(homedir(), ".gearbox"), "sessions");
const slug = () =>
  process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
const dir = () => join(root(), slug());

export interface TurnMeta {
  model: string; // model id that ran this turn (per-turn so routing can vary it)
  inputTokens: number;
  outputTokens: number;
  at: number;
}

export interface Session {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  title: string; // first user prompt, for listing
  messages: ModelMessage[]; // provider-neutral model context
  items: Item[]; // the UI transcript, for faithful restore
  turns: TurnMeta[]; // per-turn model + usage (routing/cost data)
}

const ensure = () => mkdirSync(dir(), { recursive: true });

export function newSessionId(): string {
  return `s${Date.now().toString(36)}`;
}

export function saveSession(s: Session): void {
  try {
    ensure();
    writeFileSync(join(dir(), `${s.id}.json`), JSON.stringify(s));
  } catch {
    /* persistence is best-effort; never crash the app over it */
  }
}

export function loadSession(id: string): Session | null {
  try {
    return JSON.parse(readFileSync(join(dir(), `${id}.json`), "utf8")) as Session;
  } catch {
    return null;
  }
}

/** Recent sessions for this project, newest first. */
export function listSessions(): Session[] {
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith(".json") && f !== "history.json")
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir(), f), "utf8")) as Session;
        } catch {
          return null;
        }
      })
      .filter((s): s is Session => s !== null && Array.isArray(s.items))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function latestSession(): Session | null {
  return listSessions()[0] ?? null;
}

// ── prompt history (cross-session, per project) ──
const histFile = () => join(dir(), "history.json");

export function loadHistory(): string[] {
  try {
    const h = JSON.parse(readFileSync(histFile(), "utf8"));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

export function appendHistory(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  try {
    ensure();
    const h = loadHistory();
    if (h[h.length - 1] === p) return;
    h.push(p);
    while (h.length > 500) h.shift();
    writeFileSync(histFile(), JSON.stringify(h));
  } catch {
    /* best-effort */
  }
}
