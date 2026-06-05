#!/usr/bin/env node
// Ensure UTF-8 output regardless of the shell's locale settings.
process.env.LANG = process.env.LANG || "en_US.UTF-8";
process.env.LC_ALL = process.env.LC_ALL || "en_US.UTF-8";
import React from "react";
import { render } from "ink";
import { createInterface } from "node:readline/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { App } from "./ui/App.tsx";
import { FixedSelector } from "./model/selector.ts";
import { RoutingSelector } from "./model/router.ts";
import { anyProviderAvailable } from "./config.ts";
import { MODELS } from "./providers.ts";
import { detectImageMode, setImageMode, transmitAll } from "./ui/image.ts";
import { loadPrefs } from "./ui/prefs.ts";
import { setYolo } from "./permission.ts";
import { latestSession } from "./session.ts";

const VERSION = "0.1.12";
const args = process.argv.slice(2);

const supportsAnsi = process.env.NO_COLOR !== "1" && process.env.TERM !== "dumb" && (process.stdout.isTTY || process.env.FORCE_COLOR === "1");
const ansi = (code: string) => supportsAnsi ? `\x1b[${code}m` : "";
const paint = (code: string, text: string) => `${ansi(code)}${text}${ansi("0")}`;
const bold = (text: string) => paint("1", text);
const accent = (text: string) => paint("36", text);
const dim = (text: string) => paint("2", text);
const ok = (text: string) => paint("32", text);
const warn = (text: string) => paint("33", text);
const errColor = (text: string) => paint("31", text);
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const visibleLength = (text: string) => stripAnsi(text).length;
const padVisible = (text: string, width: number) => text + " ".repeat(Math.max(width - visibleLength(text), 0));

function onboardingBoo(): string {
  return [
    "        .-''''-.",
    "      .'  .--.  '.",
    "     /   (    )   \\",
    "    |  .-.    .-.  |",
    "    |  |_|    |_|  |",
    "    |      __      |",
    "     \\   .'  '.   /",
    "      '._\\____/_.'",
    "        /|    |\\",
  ].join("\n");
}

function box(title: string, lines: string[]): void {
  const width = Math.min(78, Math.max(title.length + 4, ...lines.map((l) => visibleLength(l) + 4)));
  const rule = "─".repeat(width - 2);
  console.log(accent(`╭${rule}╮`));
  console.log(accent("│ ") + padVisible(bold(title), width - 3) + accent("│"));
  console.log(accent(`├${rule}┤`));
  for (const line of lines) {
    console.log(accent("│ ") + padVisible(line, width - 3) + accent("│"));
  }
  console.log(accent(`╰${rule}╯`));
}

function optionLine(key: string, label: string, detail: string): string {
  return `${accent(key.padStart(2))}  ${bold(label)}  ${dim(detail)}`;
}

async function runCliOnboarding(): Promise<boolean> {
  const { listAccounts } = await import("./accounts/store.ts");
  const { importableEnvCreds, importEnvCred, importableCloudCreds, importCloudCred } = await import("./accounts/detect.ts");
  const { addApiKeyAccount, addAzureAccount, addAzureFoundryAccount, addByPastedKey, testAccount, addableProviders, addCliAccount, cliAuthStatus, cliLoginArgs } = await import("./accounts/onboard.ts");
  const { subscriptionEnv } = await import("./agent/cli-backend.ts");
  const { detectProviderByKey } = await import("./accounts/catalog.ts");
  const { which } = await import("./proc.ts");
  const pipedAnswers = process.stdin.isTTY ? null : (await readStdin()).split(/\r?\n/);
  const rl = pipedAnswers ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => {
    if (pipedAnswers) {
      const answer = (pipedAnswers.shift() ?? "").trim();
      console.log(accent(q) + answer);
      return answer;
    }
    return (await rl!.question(accent(q))).trim();
  };
  const providerRows = () => addableProviders().map((p) => `  ${accent(p.id.padEnd(16))} ${p.label}`).join("\n");
  const testAndReport = async (account: any) => {
    console.log(dim("Testing credential with the provider..."));
    const t = await testAccount(account);
    console.log(t.ok ? ok(`Credential works: ${t.message}`) : warn(`Stored, but the live test failed: ${t.message}`));
  };
  const addSubscription = async (provider: "claude-cli" | "codex-cli") => {
    const res = addCliAccount(provider);
    console.log(res.ok ? ok(res.message) : errColor(res.message));
    if (!res.ok || !res.account || res.account.auth.kind !== "cli") return false;
    const bin = res.account.auth.binary;
    const profile = res.account.auth.loginProfile;
    let status = await cliAuthStatus(bin, profile);
    if (!status.loggedIn) {
      console.log(dim(`Starting ${bin} sign-in in this terminal...`));
      const r = spawnSync(bin, cliLoginArgs(bin), { stdio: "inherit", env: subscriptionEnv(bin, profile) });
      if ((r.status ?? 1) !== 0) return false;
      status = await cliAuthStatus(bin, profile);
    }
    if (!status.loggedIn) {
      console.log(warn(`${bin} did not report a completed sign-in.`));
      return false;
    }
    console.log(ok(`${bin} subscription ready${status.detail ? ` (${status.detail})` : ""}`));
    return true;
  };

  try {
    console.log("");
    if (supportsAnsi) console.log(paint("38;5;117", onboardingBoo()));
    else console.log(onboardingBoo());
    console.log("");
    console.log(bold("Gearbox setup"));
    console.log("Boo needs one model account before the coding app opens.");
    console.log(dim("Your credentials stay local. API keys are stored in Gearbox's credential store; subscription sign-ins stay inside the vendor CLI."));
    console.log("");

    while (!anyProviderAvailable()) {
      const env = importableEnvCreds();
      const cloud = importableCloudCreds();
      const existing = listAccounts();
      if (existing.length) break;

      const options: string[] = [];
      if (env.length || cloud.length) {
        const names = [...env.map((c) => c.envVar), ...cloud.map((c) => `${c.label} (${c.source})`)];
        options.push(optionLine("1", "Import detected credentials", names.join(", ")));
      }
      options.push(optionLine("2", "Paste API key", "auto-detects common key prefixes"));
      options.push(optionLine("3", "Choose provider + key", "Anthropic, OpenAI, Gemini, OpenRouter, Groq, ..."));
      options.push(optionLine("4", "Azure endpoint + key", "Azure OpenAI or Azure AI Foundry"));
      if (which("claude")) options.push(optionLine("5", "Claude subscription", "uses the official claude CLI; no token extraction"));
      if (which("codex")) options.push(optionLine("6", "ChatGPT subscription", "uses the official codex CLI; no token extraction"));
      options.push(optionLine("p", "Show provider catalog", "all API-key providers Gearbox knows how to add"));
      options.push(optionLine("q", "Quit setup", "Gearbox will not open the coding app yet"));
      box("Choose how Gearbox should connect", options);
      console.log("");
      const choice = (await ask("Selection: ")).toLowerCase();

      if (choice === "q" || choice === "quit" || choice === "skip") {
        console.log("");
        console.log(warn("Setup skipped. Run `gearbox onboard` when you are ready."));
        return false;
      }
      if (choice === "p" || choice === "providers") {
        console.log("");
        console.log(bold("Provider catalog"));
        console.log(dim("Use these ids with: gearbox auth add <provider> <api-key>"));
        console.log(providerRows());
        console.log("");
        continue;
      }
      if (choice === "1" && (env.length || cloud.length)) {
        for (const c of env) await importEnvCred(c);
        for (const c of cloud) await importCloudCred(c);
        console.log(ok(`Imported ${env.length + cloud.length} credential${env.length + cloud.length === 1 ? "" : "s"}.`));
        break;
      }
      if (choice === "2") {
        console.log(dim("Paste is visible in most terminals. Use option 3 if you want to be explicit about the provider."));
        const key = await ask("Paste API key: ");
        if (!key) continue;
        const detected = detectProviderByKey(key);
        if (!detected) {
          console.log(warn("Could not detect the provider from that key. Use option 3."));
          continue;
        }
        const res = await addByPastedKey(key);
        console.log(res.ok ? ok(res.message) : errColor(res.message));
        if (res.ok && res.account) {
          await testAndReport(res.account);
          break;
        }
        continue;
      }
      if (choice === "3") {
        console.log("");
        console.log(bold("Provider catalog"));
        console.log(providerRows());
        console.log("");
        const provider = await ask("Provider id: ");
        console.log(dim("The key is stored locally and tested before setup finishes."));
        const key = await ask("API key: ");
        const res = await addApiKeyAccount(provider, key);
        console.log(res.ok ? ok(res.message) : errColor(res.message));
        if (res.ok && res.account) {
          await testAndReport(res.account);
          break;
        }
        continue;
      }
      if (choice === "4") {
        console.log(dim("Use a resource name like my-openai-resource, or a full Foundry endpoint URL."));
        const endpoint = await ask("Azure resource name or endpoint: ");
        const key = await ask("API key: ");
        const apiVersion = await ask("API version (optional): ");
        const res = /^https?:\/\//i.test(endpoint)
          ? await addAzureFoundryAccount(endpoint, key)
          : await addAzureAccount(endpoint, key, { apiVersion: apiVersion || undefined });
        console.log(res.ok ? ok(res.message) : errColor(res.message));
        if (res.ok && res.account) {
          await testAndReport(res.account);
          break;
        }
        continue;
      }
      if (choice === "5" && which("claude")) {
        if (await addSubscription("claude-cli")) break;
        continue;
      }
      if (choice === "6" && which("codex")) {
        if (await addSubscription("codex-cli")) break;
        continue;
      }
      console.log(warn("Choose one of the listed options."));
    }

    console.log("");
    console.log(ok("Gearbox is ready."));
    console.log(`Next: ${accent("cd ~/your-project")} and run ${accent("gearbox")}.`);
    return true;
  } finally {
    rl?.close();
  }
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

if (args[0] === "upgrade" || args[0] === "update") {
  const root = resolve(import.meta.dir, "..");
  if (!existsSync(resolve(root, ".git"))) {
    console.log("This build can't self-update (not a git checkout).");
    console.log("Update by pulling the repo and reinstalling:  git pull && bun install");
    process.exit(0);
  }
  try {
    console.log("→ Pulling latest…");
    console.log(execFileSync("git", ["-C", root, "pull", "--ff-only"], { encoding: "utf8" }).trim());
    console.log("→ Installing dependencies…");
    execFileSync("bun", ["install"], { cwd: root, stdio: "inherit" });
    console.log("✓ Gearbox is up to date. Restart any running session to use the new version.");
  } catch (e: any) {
    console.log("Upgrade failed: " + (e?.message ?? String(e)));
    console.log(`Try manually:  cd ${root} && git pull && bun install`);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`gearbox ${VERSION} — multi-provider coding agent for the terminal

Usage:
  gearbox                 start in the current directory (it becomes the workspace)
  gearbox onboard         set up a provider before opening the app
  gearbox --model <name>  start with a specific model
  gearbox --continue      resume the most recent session in this directory
  gearbox mcp list        show configured MCP tools
  gearbox upgrade         pull the latest version + reinstall deps

Options:
  --model <name>      e.g. sonnet-4.6, haiku, gemini-flash, deepseek
  -c, --continue      resume the most recent session here (/resume to pick one)
  --yolo              auto-approve writes/edits/shell (no permission prompts)
  --inline            use terminal scrollback instead of the fullscreen app frame
  --fullscreen        fullscreen app frame (default when stdout is a TTY)
  -v, --version       print version
  -h, --help          this help

Set up at least one provider first:
  gearbox onboard
  gearbox auth add <api-key>
  gearbox auth add <provider> <api-key>
  gearbox auth add codex [name]
  gearbox auth add claude [name]
  gearbox auth import

Models: ${MODELS.map((m) => m.label).join(", ")}
In-app: / for commands, @ for files, !cmd for shell, shift+tab for plan mode.`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args[0] === "onboard" || args[0] === "setup") {
  await runCliOnboarding();
  process.exit(0);
}

if (args[0] === "mcp") {
  const { mcpToolSummary, mcpConfigPaths } = await import("./mcp.ts");
  const sub = args[1] ?? "list";
  if (sub === "list" || sub === "tools") {
    console.log(await mcpToolSummary());
  } else if (sub === "paths") {
    console.log(mcpConfigPaths().join("\n"));
  } else {
    console.log("gearbox mcp [list|paths]");
  }
  process.exit(0);
}

// `gearbox auth …` — headless account/credential management (no TUI). Mirrors
// the in-app /accounts command so you can set up keys from a script or SSH.
if (args[0] === "auth") {
  const { listAccounts, loadAccounts, removeAccount } = await import("./accounts/store.ts");
  const { importableEnvCreds, importEnvCred, importableCloudCreds, importCloudCred } = await import("./accounts/detect.ts");
  const { addApiKeyAccount, addByPastedKey, testAccount, addableProviders, addCliAccount, cliAuthStatus, cliLoginArgs } = await import("./accounts/onboard.ts");
  const { subscriptionEnv } = await import("./agent/cli-backend.ts");
  const { detectProviderByKey } = await import("./accounts/catalog.ts");
  const sub = args[1];
  const rest = args.slice(2);
  if (sub === "list" || !sub) {
    const f = loadAccounts();
    if (!f.accounts.length) console.log("No accounts yet. Add one:  gearbox auth add <key>   (or)   gearbox auth import");
    for (const a of f.accounts) console.log(`${f.defaults[a.provider] === a.id ? "*" : " "} ${a.id.padEnd(22)} ${a.label}${a.exec === "cli" ? " · cli" : ""}`);
    const imp = importableEnvCreds();
    if (imp.length) console.log(`\nImportable from your env (gearbox auth import): ${imp.map((c) => c.envVar).join(", ")}`);
  } else if (sub === "import") {
    const keys = importableEnvCreds();
    const cloud = importableCloudCreds();
    for (const c of keys) await importEnvCred(c);
    for (const c of cloud) await importCloudCred(c);
    const names = [...keys.map((c) => c.provider), ...cloud.map((c) => c.provider)];
    console.log(names.length ? `Imported ${names.length}: ${names.join(", ")}` : "Nothing to import.");
  } else if (sub === "add") {
    const head = (rest[0] ?? "").toLowerCase();
    const cliProvider = head === "codex" || head === "chatgpt" ? "codex-cli" : head === "claude" ? "claude-cli" : "";
    const res = cliProvider
      ? addCliAccount(cliProvider, rest.slice(1).join(" ").trim() || undefined)
      : rest[0] && !rest[1] && detectProviderByKey(rest[0])
        ? await addByPastedKey(rest[0])
        : rest[0] && rest[1]
          ? await addApiKeyAccount(rest[0], rest[1])
          : { ok: false, message: "usage: gearbox auth add <key>   |   gearbox auth add <provider> <key>   |   gearbox auth add codex [name]" };
    console.log(res.message);
    if (res.ok && res.account) {
      if (res.account.exec === "cli" && res.account.auth.kind === "cli") {
        const bin = res.account.auth.binary;
        const profile = res.account.auth.loginProfile;
        let st = await cliAuthStatus(bin, profile);
        if (!st.loggedIn) {
          console.log(`  sign-in: starting ${bin} ${cliLoginArgs(bin).join(" ")}`);
          spawnSync(bin, cliLoginArgs(bin), { stdio: "inherit", env: subscriptionEnv(bin, profile) });
          st = await cliAuthStatus(bin, profile);
        }
        console.log(st.loggedIn ? `  sign-in: ✓ ${st.detail ?? "ready"}` : `  sign-in: ✗ not signed in${st.detail ? ` (${st.detail})` : ""}`);
      } else {
        const t = await testAccount(res.account);
        console.log(t.ok ? "  test: ✓ " + t.message : "  test: ✗ " + t.message + " (stored anyway)");
      }
    }
  } else if (sub === "test" && rest[0]) {
    const a = listAccounts().find((x) => x.id === rest[0]);
    console.log(a ? `${rest[0]}: ${(await testAccount(a)).message}` : `no account ${rest[0]}`);
  } else if (sub === "rm" && rest[0]) {
    await removeAccount(rest[0]);
    console.log(`removed ${rest[0]}`);
  } else if (sub === "providers") {
    for (const p of addableProviders()) console.log(`${p.id.padEnd(16)} ${p.label} (${p.group})`);
  } else {
    console.log("gearbox auth [list|import|add <key>|add <provider> <key>|add codex [name]|add claude [name]|test <id>|rm <id>|providers]");
  }
  process.exit(0);
}

if (!anyProviderAvailable()) {
  if (process.stdin.isTTY && process.stdout.isTTY && process.env.GEARBOX_SKIP_ONBOARD !== "1") {
    const ready = await runCliOnboarding();
    if (!ready || !anyProviderAvailable()) process.exit(0);
  } else {
    console.log("Gearbox needs one provider before the coding app can open.");
    console.log("Run: gearbox onboard");
    console.log("Or:  gearbox auth add <api-key>");
    process.exit(1);
  }
}

const mi = args.indexOf("--model");
const preferred = mi >= 0 ? args[mi + 1] : undefined;
// Selector at launch: --model wins; else a pinned model persisted from a prior
// session (/model <name>); else routing. (The active subscription account is
// restored inside the App from the same prefs.)
const pinned = preferred ?? loadPrefs().pinnedModel;
const selector = pinned ? new FixedSelector(pinned) : new RoutingSelector();
if (args.includes("--yolo")) setYolo(true); // start with writes/edits/shell auto-approved
// --continue / -c resumes the most recent session for this directory.
const resumeId = args.includes("--continue") || args.includes("-c") ? (latestSession()?.id ?? undefined) : undefined;

// Resolve how Boo renders, once, and share it with the UI.
const imageMode = detectImageMode();
setImageMode(imageMode);

// kitty/Ghostty: transmit the PNGs once (only when GEARBOX_GHOST=kitty is opted in);
// the UI references them via cheap Unicode placeholders (a=T,U=1 draws nothing).
if (process.stdout.isTTY && imageMode === "kitty") process.stdout.write(transmitAll());

// Fullscreen is the DEFAULT: the app owns a stable frame and the composer stays
// pinned to the bottom, like the coding CLIs users expect. Inline remains
// available when terminal scrollback is more important than a fixed footer.
const uiPrefs = loadPrefs();
const explicitInline = args.includes("--inline") || process.env.GEARBOX_INLINE === "1" || process.env.GEARBOX_FULLSCREEN === "0";
const explicitFullscreen = args.includes("--fullscreen") || process.env.GEARBOX_FULLSCREEN === "1";
const wantsInline = explicitInline || (!explicitFullscreen && uiPrefs.fullscreen === false);
const wantsFullscreen = !wantsInline;
const fullscreen = Boolean(process.stdout.isTTY) && wantsFullscreen;
const mouse = Boolean(process.stdout.isTTY) && process.env.GEARBOX_MOUSE !== "0";
const restore = () => {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?2004l\x1b[?25h"); // bracketed paste off, native cursor back on
  if (mouse) process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  if (fullscreen) process.stdout.write("\x1b[?1049l");
};
// Keep bracketed paste OFF. Some Ink/terminal combinations deliver the paste
// markers as literal "[200~" chunks; normal paste is less surprising.
if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l\x1b[?25l");
if (fullscreen) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
if (mouse) process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");

// exitOnCtrlC:false so the app can handle ⌃C itself (interrupt / clear / confirm-quit).
const app = render(<App selector={selector} fullscreen={fullscreen} resumeId={resumeId} />, { exitOnCtrlC: false });
app.waitUntilExit().then(restore, restore);
process.on("exit", restore);
