// Extract REAL user prompts from Claude Code transcripts (~/.claude/projects)
// to harden the T1 classifier corpus with genuine data instead of only the
// hand-authored set. Writes the full deduped list to a LOCAL (git-ignored) file
// and prints a sample + summary. Real prompts are the user's own history, so the
// committed corpus only gets a curated innocuous subset; the bulk measurement
// runs against the local file.
//
// Run: bun run experiments/routing/extract-prompts.ts
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".claude", "projects");

function* walk(dir: string): Generator<string> {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) yield* walk(p);
    else if (e.endsWith(".jsonl")) yield p;
  }
}

// True for noise we never want to treat as a natural-language task prompt.
function isNoise(t: string): boolean {
  if (!t) return true;
  if (t.startsWith("/") || t.startsWith("!")) return true; // slash command / shell
  if (/^<(command-name|command-message|command-args|local-command|bash-|user-prompt)/.test(t)) return true;
  if (t.includes("<command-name>") || t.includes("<local-command")) return true;
  if (t.includes("Caveat: The messages below")) return true;
  if (t.startsWith("<system-reminder>") || t.includes("This session is being continued")) return true;
  if (t.startsWith("[Request interrupted") || t.startsWith("[Image") || t.startsWith("[Pasted")) return true;
  if (/^(tool_result|tool_use)\b/.test(t)) return true;
  if (t.startsWith("<task-") || t.includes("<task-notification")) return true; // agent system messages
  return false;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join(" ");
  }
  return "";
}

const seen = new Set<string>();
const prompts: string[] = [];
let rawUserMsgs = 0;
let dropped = 0;
let droppedLong = 0;

for (const file of walk(ROOT)) {
  let lines: string[];
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { continue; }
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    if (o?.type !== "user" || o?.message?.role !== "user") continue;
    rawUserMsgs++;
    let t = textOf(o.message.content).replace(/\s+/g, " ").trim();
    if (isNoise(t)) { dropped++; continue; }
    if (t.length > 500) { droppedLong++; continue; } // pastes — not natural prompts
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prompts.push(t);
  }
}

const outFile = join(import.meta.dir, "real-prompts.local.txt");
writeFileSync(outFile, prompts.join("\n"), { mode: 0o600 });

console.log(`raw user messages:     ${rawUserMsgs}`);
console.log(`dropped (noise):       ${dropped}`);
console.log(`dropped (>500 chars):  ${droppedLong}`);
console.log(`distinct natural prompts: ${prompts.length}`);
console.log(`written to: ${outFile}`);
console.log(`\n=== sample (every Nth, ~70) ===`);
const step = Math.max(1, Math.floor(prompts.length / 70));
for (let i = 0; i < prompts.length; i += step) {
  console.log(`  ${prompts[i]!.slice(0, 110)}`);
}
