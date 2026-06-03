// Live smoke for auto-compaction: build a multi-turn history, summarize the old
// turns with a real model (via modelSummarizer), and show the before/after token
// counts + the summary. Verifies the cheap-model delegation path end-to-end.
// Run: bun run experiments/context/smoke-compact.ts
import { existsSync, readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import { compactHistory, modelSummarizer, estimateHistoryTokens } from "../../src/context/compact.ts";
import { findModel } from "../../src/providers.ts";

const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath))
  for (const l of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("No ANTHROPIC_API_KEY — skipping.");
  process.exit(0);
}

const model = findModel("haiku-4.5")!;

// A synthetic session: a few turns of real-ish coding work.
const history: ModelMessage[] = [
  { role: "user", content: "Add a --version flag to the CLI." },
  { role: "assistant", content: [{ type: "text", text: "I'll read cli.tsx first." }, { type: "tool-call", toolCallId: "a1", toolName: "read_file", input: { path: "src/cli.tsx" } }] as any },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "a1", toolName: "read_file", output: { type: "text", value: "// cli entry ...\n".repeat(40) } }] as any },
  { role: "assistant", content: "Added a --version branch that prints the package version and exits." },
  { role: "user", content: "Now make it also accept -v." },
  { role: "assistant", content: [{ type: "text", text: "Editing the arg parse." }, { type: "tool-call", toolCallId: "b1", toolName: "edit_file", input: { path: "src/cli.tsx" } }] as any },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "b1", toolName: "edit_file", output: { type: "text", value: "edited 1 hunk" } }] as any },
  { role: "assistant", content: "Done — -v is now an alias for --version. Verified by running `gearbox -v`." },
  { role: "user", content: "Great. What's the current default model?" },
  { role: "assistant", content: "The default is claude-sonnet-4-6 from src/config.ts." },
];

console.log(`\nbefore: ${history.length} messages · ~${estimateHistoryTokens(history, model.id)} tokens`);
const res = await compactHistory({ history, summarize: modelSummarizer(model), keepRecent: 1 });
if (!res) {
  console.log("nothing to compact");
  process.exit(0);
}
console.log(`after:  ${res.messages.length} messages · ~${res.after} tokens (${res.summarizedTurns} turns summarized, ~${res.before - res.after} freed)\n`);
console.log("=== summary the model produced ===\n");
console.log(String((res.messages[1] as any).content));
console.log("\n=== kept verbatim (recent) ===");
for (const m of res.messages.slice(2)) console.log(`  ${m.role}: ${JSON.stringify((m as any).content).slice(0, 80)}`);
