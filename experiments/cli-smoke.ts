// Live smoke for the CLI-backed runner: drive the real `claude` binary through
// runCliTask and confirm the AgentEvent mapping + usage/session come back.
// Run: bun run experiments/cli-smoke.ts
import { runCliTask } from "../src/agent/cli-backend.ts";

const binary = process.argv[2] ?? "claude";
console.log(`\n=== runCliTask via ${binary} ===\n`);
const r = await runCliTask({
  binary,
  prompt: "reply with exactly: hi from gearbox",
  messages: [],
  cwd: "/tmp",
  onEvent: (e) => {
    if (e.type === "text") process.stdout.write(e.text);
    else if (e.type === "tool-start") process.stdout.write(`\n[tool ${e.name} ${e.arg ?? ""}]`);
    else if (e.type === "error") process.stdout.write(`\n[error ${e.message}]`);
  },
});
console.log(`\n\nmessages: ${r.messages.length} (last role: ${r.messages.at(-1)?.role})`);
console.log(`usage: in ${r.usage.inputTokens} / out ${r.usage.outputTokens}` + (r.costUSD != null ? ` · $${r.costUSD.toFixed(4)}` : ""));
console.log(`sessionId: ${r.sessionId ?? "(none)"}`);
