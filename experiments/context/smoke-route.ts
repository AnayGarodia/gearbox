// Shows the router's per-task picks with whatever keys are present. No model
// calls — pure routing decisions + their stated reasons.
// Run: bun run experiments/context/smoke-route.ts
import { existsSync, readFileSync } from "node:fs";
import { RoutingSelector } from "../../src/model/router.ts";

const envPath = `${import.meta.dir}/../.env.local`;
if (existsSync(envPath))
  for (const l of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(l.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }

const r = new RoutingSelector();
const prompts = [
  "implement a debounce helper with types",
  "find and fix the off-by-one in the pager",
  "summarize what changed in this diff",
  "where is the default model configured?",
  "classify this error as transient or fatal",
  "refactor the retrieval index for clarity",
];

console.log("\nrouter picks (keys present drive the candidate set):\n");
for (const p of prompts) {
  try {
    const c = r.select({ prompt: p });
    console.log(`  ${c.model.label.padEnd(14)} ← ${c.reason.padEnd(38)} | "${p}"`);
  } catch (e: any) {
    console.log(`  (no model) ${e.message}`);
    break;
  }
}
console.log("");
