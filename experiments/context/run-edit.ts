// E-C — Edit correctness PER TOKEN (the capstone: does curation cost quality?).
// On the REAL repo, for tasks with an auto-checkable correct edit, compare two
// contexts the model is given to make the edit:
//   FULL   — every src file concatenated (~the "dump everything" naive ceiling)
//   CURATED — a signature map (awareness) + the top-3 lexically-retrieved files
// Both contain the file that must change; FULL adds ~5× more noise. If CURATED
// matches FULL's correctness at a fraction of the tokens, curation is free quality.
// Live (Anthropic). Run: bun run experiments/context/run-edit.ts [--sonnet]
import { existsSync, readFileSync } from "node:fs";

const keys: Record<string, string> = { ...process.env } as any;
const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath)) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim()); if (m) keys[m[1]] = m[2]; }
if (!keys.ANTHROPIC_API_KEY) { console.log("set ANTHROPIC_API_KEY (experiments/.env.local) to run"); process.exit(0); }
const MODEL = process.argv.includes("--sonnet") ? "claude-sonnet-4-6" : "claude-haiku-4-5";

const root = `${import.meta.dir}/../..`;
const srcFiles = Bun.spawnSync(["git", "ls-files", "src"], { cwd: root, stdout: "pipe" }).stdout.toString().split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
const read = (f: string) => { try { return readFileSync(`${root}/${f}`, "utf8"); } catch { return ""; } };

// signature map (awareness)
const SIG = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|enum)\s+[A-Za-z0-9_]+/;
const sigMap = srcFiles.map((f) => { const s = read(f).split("\n").filter((l) => SIG.test(l)).map((l) => "  " + l.trim()); return s.length ? `${f}\n${s.join("\n")}` : ""; }).filter(Boolean).join("\n");
const fullDump = srcFiles.map((f) => `// FILE: src/${f}\n${read(f)}`).join("\n\n");

// tiny lexical retriever for the curated variant (no oracle — picks by term overlap)
const terms = (s: string) => s.toLowerCase().match(/[a-z_]{3,}/g) ?? [];
function top3(q: string): string[] {
  const qt = terms(q);
  return srcFiles
    .map((f) => { const c = read(f).toLowerCase(); let s = 0; for (const t of qt) { s += (c.split(t).length - 1); if (f.toLowerCase().includes(t)) s += 50; } return [f, s] as [string, number]; })
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
}

type Task = { q: string; check: (out: string) => boolean };
const TASKS: Task[] = [
  { q: "Change the edit_file tool so it replaces EVERY occurrence of `find`, not just the first.", check: (o) => /replaceAll|replace\([^)]*\/g|new RegExp/.test(o) && /edit_file|find/.test(o) },
  { q: "Add an optional `cost` number to the ModelSpec interface (USD per million input tokens), and set claude-haiku-4-5's cost to 0.25.", check: (o) => /cost\??\s*:\s*number/.test(o) && /0\.25/.test(o) },
  { q: "Make run_shell refuse to execute any command containing 'rm -rf /' by throwing an error before running it.", check: (o) => /rm\s*-rf|rm -rf/.test(o) && /throw/.test(o) },
];

async function ask(context: string, q: string): Promise<{ out: string; inTok: number }> {
  const sys = "You are a precise coding agent editing the Gearbox codebase. Make the requested change. Output ONLY the full updated content of the single file you edit, in a ```ts code block, with a first comment line `// FILE: <path>`.";
  const user = `${context}\n\n--- TASK ---\n${q}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": keys.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: sys, messages: [{ role: "user", content: user }] }) });
  const j: any = await res.json();
  return { out: j?.content?.[0]?.text ?? JSON.stringify(j).slice(0, 200), inTok: j?.usage?.input_tokens ?? 0 };
}

const COUNT = { in: 0, out: 0 };
console.log(`\nE-C · edit-correctness per token  (model: ${MODEL})\n`);
console.log("task                              FULL dump          CURATED (map+top3)");
console.log("────────────────────────────────────────────────────────────────────────");
for (const t of TASKS) {
  const curated = `SIGNATURE MAP (repo awareness):\n${sigMap}\n\n--- RELEVANT FILES ---\n` + top3(t.q).map((f) => `// FILE: src/${f}\n${read(f)}`).join("\n\n");
  const full = await ask(fullDump, t.q);
  const cur = await ask(curated, t.q);
  COUNT.in += full.inTok + cur.inTok;
  const label = t.q.slice(0, 32).padEnd(32);
  console.log(`${label}  ${t.check(full.out) ? "✓" : "✗"} ${String(full.inTok).padStart(6)} tok    ${t.check(cur.out) ? "✓" : "✗"} ${String(cur.inTok).padStart(6)} tok`);
}
const cost = (COUNT.in / 1e6) * (MODEL.includes("sonnet") ? 3 : 0.25);
console.log(`\ninput tokens total: ${COUNT.in.toLocaleString()}  ·  ~$${cost.toFixed(4)}`);
console.log("Win = CURATED matches FULL's ✓ at far fewer tokens (curation is free quality).\n");
