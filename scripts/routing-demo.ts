// Routing demo: see the router pick different models per task — no spend, no
// network. It sets up a SYNTHETIC set of metered accounts (cheap / mid / strong
// across providers) in a throwaway home, then asks the REAL RoutingSelector to
// explain its pick for a spread of representative tasks.
//
//   bun run scripts/routing-demo.ts
//
// With a single free subscription seat the seat wins everything (it's ~free and
// clears the bar) — that's correct routing, just invisible. This demo removes
// the dominating seat so the cheapest-that-clears-the-bar actually varies.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway home so we never touch the real ~/.gearbox, and fake env keys so the
// providers count as available to the router.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-routing-demo-"));
process.env.ANTHROPIC_API_KEY = "demo";
process.env.OPENAI_API_KEY = "demo";
process.env.DEEPSEEK_API_KEY = "demo";

const { saveAccounts } = await import("../src/accounts/store.ts");
const { RoutingSelector } = await import("../src/model/router.ts");

saveAccounts({
  version: 1,
  accounts: [
    { id: "anthropic", provider: "anthropic", exec: "in-loop", enabled: true, label: "anthropic", auth: { kind: "api-key", ref: "anthropic:k" }, addedAt: 0 },
    { id: "openai", provider: "openai", exec: "in-loop", enabled: true, label: "openai", auth: { kind: "api-key", ref: "openai:k" }, addedAt: 0 },
    { id: "deepseek", provider: "deepseek", exec: "in-loop", enabled: true, label: "deepseek", auth: { kind: "api-key", ref: "deepseek:k" }, addedAt: 0 },
  ],
  defaults: {},
} as any);

// estTokens + touchedFiles are the difficulty signals a real turn carries (the
// retrieved context size and the files the change spans). They're what makes a
// hard task escalate above the cheap default — so the demo passes them.
const TASKS: { prompt: string; about: string; estTokens?: number; touchedFiles?: string[] }[] = [
  { prompt: "hey, how's it going?", about: "small talk", estTokens: 400 },
  { prompt: "summarize what this module does", about: "summarize", estTokens: 6000 },
  { prompt: "find where the auth token is validated", about: "search the codebase", estTokens: 2000 },
  { prompt: "fix the off-by-one in the pagination loop", about: "small bugfix", estTokens: 4000, touchedFiles: ["pager.ts"] },
  {
    prompt: "implement a recursive-descent parser with correct operator precedence and error handling",
    about: "hard code",
    estTokens: 70000,
    touchedFiles: ["parser.ts", "lexer.ts", "ast.ts", "eval.ts", "errors.ts"],
  },
  { prompt: "design the architecture for a multi-tenant billing system with usage metering", about: "planning", estTokens: 45000 },
];

const sel = new RoutingSelector();
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

console.log("\n" + bold("  Routing demo") + dim("  · synthetic accounts: anthropic · openai · deepseek · google\n"));

for (const t of TASKS) {
  // Simulate a fresh project with no test net (the "I just started building"
  // case) so escalation is visible: with tests, code is cheap-first instead.
  const task = { prompt: t.prompt, estTokens: t.estTokens, touchedFiles: t.touchedFiles, verifierTier: "none" as const };
  const card = sel.explain ? sel.explain(task) : null;
  const choice = sel.select(task);
  const winner = card?.entries.find((e) => e.chosen);
  const runnerUp = card?.entries.filter((e) => !e.chosen)[0];
  const kind = card?.kind ?? "?";
  console.log("  " + bold(t.about.padEnd(16)) + dim(`(${kind})`));
  console.log("    " + dim("task: ") + t.prompt.slice(0, 70));
  console.log("    " + cyan("→ " + (winner?.label ?? choice.model.label)) + dim(`   ${winner?.verdict ?? choice.reason}`));
  if (runnerUp) console.log("    " + dim(`  runner-up: ${runnerUp.label} (${runnerUp.verdict})`));
  console.log("");
}

console.log(dim("  Same engine /why uses. Add your own accounts and re-run gearbox to route for real.\n"));
