// Live end-to-end smoke for the Context Engine: build a repo-aware working set
// for a behavior-described question, run ONE real turn (haiku — cheap), and
// print the /context breakdown + the model's answer + token usage. This is the
// path the unit tests can't cover (real provider round-trip).
// Run: bun run experiments/context/smoke.ts   (reads key from experiments/.env.local)
import { existsSync, readFileSync } from "node:fs";
import { buildContext } from "../../src/context/builder.ts";
import { runTask } from "../../src/agent/run.ts";
import { findModel } from "../../src/providers.ts";
import { formatContextBreakdown } from "../../src/commands.ts";

// Load the key the same way the other experiments do.
const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath))
  for (const l of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("No ANTHROPIC_API_KEY (set it in experiments/.env.local) — skipping live smoke.");
  process.exit(0);
}

const model = findModel("haiku-4.5")!;
const userText = "where is the model actually chosen, and how would I change the default model?";

const { system, messages, sections } = buildContext({ history: [], userText, model });

console.log("\n=== /context breakdown (working set for this turn) ===");
console.log(formatContextBreakdown(sections, model.contextWindow));
console.log(`\nsystem prompt: ${system.length} chars · ${messages.length} message(s)`);
console.log(`(system should contain a REPO MAP + RELEVANT FILES section if retrieval fired)`);
console.log("repo map present:", system.includes("REPO MAP"));
console.log("retrieved files present:", system.includes("RELEVANT FILES"));

console.log("\n=== live turn (haiku) ===\n");
const r = await runTask({
  model,
  messages,
  system,
  onEvent: (e) => {
    if (e.type === "text") process.stdout.write(e.text);
    else if (e.type === "tool-start") process.stdout.write(`\n[tool: ${e.name} ${e.arg ?? ""}]\n`);
    else if (e.type === "error") process.stdout.write(`\n[error: ${e.message}]\n`);
  },
});

console.log(`\n\n=== usage === input ${r.usage.inputTokens} · output ${r.usage.outputTokens} tokens`);
