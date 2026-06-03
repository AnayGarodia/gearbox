// Live end-to-end: import an API key as a stored ACCOUNT (keychain/file store),
// resolve its creds, and run a real turn through it — proving the account →
// resolveCreds → resolveModel → runTask path, independent of env-var defaults.
// Run: bun run experiments/accounts-smoke.ts
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated store + force the file backend so the smoke never touches the real
// keychain/home. Set BEFORE importing the store modules.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-acct-smoke-"));
process.env.GEARBOX_SECRET_STORE = "file";

const envPath = `${import.meta.dir}/.env.local`;
let key = process.env.ANTHROPIC_API_KEY;
if (!key && existsSync(envPath)) {
  for (const l of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^ANTHROPIC_API_KEY\s*=\s*(.+)$/.exec(l.trim());
    if (m) key = m[1];
  }
}
if (!key) {
  console.error("No ANTHROPIC_API_KEY (env or experiments/.env.local) — skipping.");
  process.exit(0);
}
// Make sure resolution uses the ACCOUNT, not an ambient env key.
delete process.env.ANTHROPIC_API_KEY;

const { importEnvCred } = await import("../src/accounts/detect.ts");
const { resolveCreds, AccountResolver } = await import("../src/accounts/resolve.ts");
const { listAccounts } = await import("../src/accounts/store.ts");
const { runTask } = await import("../src/agent/run.ts");
const { findModel } = await import("../src/providers.ts");

const acc = await importEnvCred({ provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", value: key });
console.log("stored account:", acc.id, "| registry now:", listAccounts().map((a) => a.id));

const picked = new AccountResolver().pick("anthropic")!;
const creds = await resolveCreds(picked);
console.log("resolved creds: apiKey", creds.apiKey ? `${creds.apiKey.slice(0, 10)}…` : "(none)");

const model = findModel("haiku-4.5")!;
console.log("\n=== live turn via the stored account ===\n");
const r = await runTask({
  model,
  messages: [{ role: "user", content: "In one short sentence, what is a coding agent?" }],
  creds,
  onEvent: (e) => {
    if (e.type === "text") process.stdout.write(e.text);
    else if (e.type === "error") process.stdout.write(`\n[error: ${e.message}]\n`);
  },
});
console.log(`\n\nusage: input ${r.usage.inputTokens} · output ${r.usage.outputTokens} tokens (ran on account "${picked.id}", no env key present)`);
