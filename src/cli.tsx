#!/usr/bin/env node
// Ensure UTF-8 output regardless of the shell's locale settings.
process.env.LANG = process.env.LANG || "en_US.UTF-8";
process.env.LC_ALL = process.env.LC_ALL || "en_US.UTF-8";
import React from "react";
import { render } from "ink";
import { createInterface } from "node:readline/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { App } from "./ui/App.tsx";
import { Conductor } from "./ui/components/Conductor.tsx";
import { FixedSelector } from "./model/selector.ts";
import { RoutingSelector } from "./model/router.ts";
import { anyProviderAvailable } from "./config.ts";
import { modelRegistry } from "./providers.ts";
import { detectImageMode, setImageMode, transmitAll } from "./ui/image.ts";
import { loadPrefs } from "./ui/prefs.ts";
import { setYolo } from "./permission.ts";
import { latestSession } from "./session.ts";
import { renderGhost, type SpriteCell } from "./ui/ghost/engine.ts";
import { wordmarkGradient, setTheme } from "./ui/theme.ts";
import pkg from "../package.json";

// Inlined by the bundler at build time, so --version can never drift from
// package.json again (it sat at a stale hardcoded 0.2.81 for six releases).
const VERSION = pkg.version;
const args = process.argv.slice(2);

const supportsAnsi = process.env.FORCE_COLOR === "1" || (process.env.TERM !== "dumb" && process.env.NO_COLOR !== "1" && process.stdout.isTTY);
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

const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const trueFg = (h: string) => `\x1b[38;2;${hexRgb(h).join(";")}m`;
const trueBg = (h: string) => `\x1b[48;2;${hexRgb(h).join(";")}m`;

function ghostLines(cells: SpriteCell[][], pad = "  "): string[] {
  return cells.map((row) => {
    let line = pad;
    for (const { t, b } of row) {
      if (supportsAnsi && t && b) line += trueFg(t) + trueBg(b) + "▀" + ansi("0");
      else if (supportsAnsi && t) line += trueFg(t) + "▀" + ansi("0");
      else if (supportsAnsi && b) line += trueFg(b) + "▄" + ansi("0");
      else if (t && b) line += "█";
      else if (t) line += "▀";
      else if (b) line += "▄";
      else line += " ";
    }
    return line;
  });
}

function onboardingBanner(termWidth: number): void {
  const w = Math.min(termWidth, 120);
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((w - visibleLength(s)) / 2));
    return " ".repeat(pad) + s;
  };

  const RST  = supportsAnsi ? "\x1b[0m" : "";
  const BOLD = supportsAnsi ? "\x1b[1m" : "";
  const rgb  = (r: number, g: number, b: number) =>
    supportsAnsi ? `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m` : "";

  // A smooth horizontal gradient across the wordmark (bright cyan → mid → deep
  // teal), so the letters flow instead of sitting flat. Same-hue ramp derived
  // from the in-app theme accent, so install and running app read as one brand
  // (no off-palette indigo). The solid fills (█) are the lit face at the column's
  // hue; the box-drawing 3-D edge tracks the SAME hue, darker.
  type RGB = [number, number, number];
  const STOPS: RGB[] = wordmarkGradient.map((h) => hexRgb(h) as RGB);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const grad = (t: number): RGB => {
    const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(x));
    const f = x - i;
    const a = STOPS[i]!, b = STOPS[i + 1]!;
    return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
  };
  const dim = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

  // Color each cell by its column position so the hue advances left-to-right.
  const colorize = (s: string): string => {
    const n = Math.max(1, s.length - 1);
    return s.split("").map((c, i) => {
      if (c === " ") return " ";
      const col = grad(i / n);
      return c === "█" ? rgb(col[0], col[1], col[2]) + c + RST : rgb(...(dim(col, 0.42) as RGB)) + c + RST;
    }).join("");
  };

  // ANSI-shadow figlet style — box-drawing corners create the 3-D depth.
  const F: Record<string, string[]> = {
    G: [
      " ██████╗ ",
      "██╔════╝ ",
      "██║  ███╗",
      "██║   ██║",
      "╚██████╔╝",
      " ╚═════╝ ",
    ],
    E: [
      "███████╗",
      "██╔════╝",
      "█████╗  ",
      "██╔══╝  ",
      "███████╗",
      "╚══════╝",
    ],
    A: [
      " █████╗ ",
      "██╔══██╗",
      "███████║",
      "██╔══██║",
      "██║  ██║",
      "╚═╝  ╚═╝",
    ],
    R: [
      "██████╗ ",
      "██╔══██╗",
      "██████╔╝",
      "██╔══╗  ",
      "██║  ██╗",
      "╚═╝  ╚═╝",
    ],
    B: [
      "██████╗ ",
      "██╔══██╗",
      "██████╔╝",
      "██╔══██╗",
      "██████╔╝",
      "╚═════╝ ",
    ],
    O: [
      " ██████╗ ",
      "██╔═══██╗",
      "██║   ██║",
      "██║   ██║",
      "╚██████╔╝",
      " ╚═════╝ ",
    ],
    X: [
      "██╗  ██╗",
      "╚██╗██╔╝",
      " ╚████╔╝",
      " ██╔╗██ ",
      "██╔╝╚██╗",
      "╚═╝  ╚═╝",
    ],
  };

  const letters = "GEARBOX".split("");
  const wordWidth = letters.map((ch) => visibleLength(F[ch]?.[0] ?? "")).reduce((a, b) => a + b, 0) + (letters.length - 1) * 2;
  console.log("");
  for (let r = 0; r < 6; r++) {
    const raw = letters.map((ch) => F[ch]?.[r] ?? "").join("  ");
    console.log(center(colorize(raw)));
  }
  // A thin gradient underline the width of the wordmark, ties it together.
  const rule = Array.from({ length: wordWidth }, (_, i) => {
    const c = dim(grad(i / Math.max(1, wordWidth - 1)), 0.85);
    return rgb(c[0], c[1], c[2]) + "▁" + RST;
  }).join("");
  console.log(center(rule));
  console.log("");
  // Taglines: brand promise, then the privacy line — both in the gradient's hue.
  const m1 = grad(0.32), m2 = grad(0.62);
  console.log(center(`${rgb(m1[0], m1[1], m1[2])}${BOLD}every model you pay for${RST}${rgb(m1[0], m1[1], m1[2])}, one terminal${RST}`));
  console.log(center(`${rgb(...(dim(m2, 0.8) as RGB))}your keys stay local · nothing is ever sent anywhere${RST}`));
  console.log("");
}

const centerStr = (text: string, width: number): string => {
  const pad = Math.max(0, Math.floor((width - visibleLength(text)) / 2));
  return " ".repeat(pad) + text;
};

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
    const termWidth = Math.min(process.stdout.columns || 80, 100);
    onboardingBanner(termWidth);

    while (!anyProviderAvailable()) {
      const env = importableEnvCreds();
      const cloud = importableCloudCreds();
      const existing = listAccounts();
      if (existing.length) break;

      // Numbers are assigned SEQUENTIALLY over the options actually shown (the
      // import row appears only when creds are detected; the subscription rows
      // only when the vendor CLI is installed) — so the menu always starts at 1.
      // `acts` maps the typed number back to a stable action id.
      const options: string[] = [];
      const acts: string[] = [];
      const opt = (action: string, label: string, desc: string) => {
        acts.push(action);
        options.push(optionLine(String(acts.length), label, desc));
      };
      if (env.length || cloud.length) {
        const names = [...env.map((c) => c.envVar), ...cloud.map((c) => `${c.label} (${c.source})`)];
        opt("import", "Import detected credentials", names.join(", "));
      }
      opt("paste", "Paste API key", "auto-detects common key prefixes");
      opt("provider", "Choose provider + key", "Anthropic, OpenAI, Gemini, OpenRouter, Groq, ...");
      opt("azure", "Azure endpoint + key", "Azure OpenAI or Azure AI Foundry");
      if (which("claude")) opt("claude", "Claude subscription", "uses the official claude CLI; no token extraction");
      if (which("codex")) opt("codex", "ChatGPT subscription", "uses the official codex CLI; no token extraction");
      options.push(optionLine("p", "Show provider catalog", "all API-key providers Gearbox knows how to add"));
      options.push(optionLine("q", "Quit setup", "Gearbox will not open the coding app yet"));
      box("Choose how Gearbox should connect", options);
      console.log("");
      const choice = (await ask("Selection: ")).toLowerCase();
      const action = acts[Number(choice) - 1] ?? "";

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
      if (action === "import") {
        for (const c of env) await importEnvCred(c);
        for (const c of cloud) await importCloudCred(c);
        console.log(ok(`Imported ${env.length + cloud.length} credential${env.length + cloud.length === 1 ? "" : "s"}.`));
        break;
      }
      if (action === "paste") {
        console.log(dim("Paste is visible in most terminals. Use the provider + key option if you want to be explicit."));
        const key = await ask("Paste API key: ");
        if (!key) continue;
        const detected = detectProviderByKey(key);
        if (!detected) {
          console.log(warn("Could not detect the provider from that key. Use the provider + key option."));
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
      if (action === "provider") {
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
      if (action === "azure") {
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
      if (action === "claude") {
        if (await addSubscription("claude-cli")) break;
        continue;
      }
      if (action === "codex") {
        if (await addSubscription("codex-cli")) break;
        continue;
      }
      console.log(warn("Choose one of the listed options."));
    }

    console.log("");
    console.log(centerStr(ok("✓  you're all set"), termWidth));
    console.log("");
    console.log(centerStr(dim(`cd ~/your-project  →  ${accent("gearbox")}`), termWidth));
    console.log("");
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

if (["upgrade", "update", "--upgrade", "--update"].includes(args[0] ?? "")) {
  // Resolve this module's dir cross-runtime: import.meta.dir is Bun-only and is
  // undefined under Node (the installed binary runs on node), which used to crash
  // path.resolve. fileURLToPath(import.meta.url) works on both.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(resolve(root, ".git"))) {
    // The published/installed build: actually RUN the official installer, which
    // re-fetches @latest from npm and replaces the binary. No shell string (no
    // injection): download with curl, then run the script with bash. Skip the
    // post-install onboarding prompt — this is an update, already set up.
    const url = "https://unpkg.com/gearbox-code@latest/install.sh";
    const script = join(tmpdir(), "gearbox-install.sh");
    const manual = `  curl -fsSL ${url} | bash`;
    try {
      console.log("→ updating Gearbox to the latest version…");
      execFileSync("curl", ["-fsSL", url, "-o", script], { stdio: ["ignore", "ignore", "inherit"] });
      execFileSync("bash", [script], { stdio: "inherit", env: { ...process.env, GEARBOX_SKIP_ONBOARD: "1" } });
      console.log("✓ updated · run `gearbox` to use the new version");
    } catch (e: any) {
      console.log(`Update failed: ${e?.shortMessage ?? e?.message ?? e}`);
      console.log("Run it manually:");
      console.log(manual);
    }
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
  gearbox mcp list        show configured MCP servers
  gearbox mcp add <name> <command> [args...]
  gearbox doctor models   show provider/model capability matrix
  gearbox acp             ACP agent mode for editors (Zed/JetBrains/Neovim spawn this over stdio)
  gearbox upgrade         pull the latest version + reinstall deps

Options:
  --model <name>      e.g. sonnet-4.6, haiku, gemini-flash, deepseek
  -c, --continue      resume the most recent session here (/resume to pick one)
  -p, --print "…"     headless one-shot: answer and exit (read-only tools; --yolo to allow edits; --json for scripts)
  --yolo              auto-approve writes/edits/shell (no permission prompts)
  --inline            use terminal scrollback instead of the fullscreen frame
  --fullscreen        fullscreen app frame (default)
  -v, --version       print version
  -h, --help          this help

Set up at least one provider first:
  gearbox onboard
  gearbox auth add <api-key>
  gearbox auth add <provider> <api-key>
  gearbox auth add openai-compat <name> <base-url> <api-key> <model>
  gearbox auth add codex [name]
  gearbox auth add claude [name]
  gearbox auth import

Models: ${modelRegistry().map((m) => m.label).join(", ")}
In-app: / for commands, @ for files, !cmd for shell, shift+tab cycles normal · auto-accept · plan.`);
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

// ACP agent mode: an editor (Zed, JetBrains, Neovim) spawns `gearbox acp` and
// speaks the Agent Client Protocol over stdio. STDOUT IS THE WIRE — this path
// must never reach Ink, onboarding, or any console.log.
if (args[0] === "acp") {
  const { runAcpStdio } = await import("./acp/server.ts");
  await runAcpStdio();
  process.exit(0);
}

// Headless one-shot: `gearbox -p "prompt"` prints the answer and exits — the
// building-block mode for CI, cron, and pipelines. Tools are READ-ONLY unless
// --yolo (there's no human at a permission prompt to say no). --json emits
// {text, model, usage} for scripts.
const pIdx = args.findIndex((a) => a === "-p" || a === "--print");
if (pIdx >= 0) {
  const jsonOut = args.includes("--json");
  const yolo = args.includes("--yolo");
  // Parse --model / --effort (each takes a value) and strip them — and their
  // values — from the prompt. Previously they leaked into the prompt text and
  // --model was ignored entirely (the one-shot always auto-routed).
  let pinnedModel: string | undefined;
  let effort: string | undefined;
  const rest = args.slice(pIdx + 1);
  const promptParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json" || a === "--yolo") continue;
    if (a === "--model") { pinnedModel = rest[++i]; continue; }
    if (a === "--effort") { effort = rest[++i]; continue; }
    promptParts.push(a);
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error('usage: gearbox -p "prompt" [--model <id|auto>] [--effort <level>] [--json] [--yolo]');
    process.exit(2);
  }
  const { runTask } = await import("./agent/run.ts");
  const { RoutingSelector, SubscriptionPinSelector } = await import("./model/router.ts");
  const { FixedSelector } = await import("./model/selector.ts");
  const { subscriptionSeats } = await import("./providers.ts");
  const { buildContext } = await import("./context/builder.ts");
  const { resolveCreds } = await import("./accounts/resolve.ts");
  const { defaultAccount } = await import("./accounts/store.ts");
  const { recordSpend, resolveTurnCost } = await import("./accounts/ledger.ts");
  try {
    let choice;
    const wantPin = pinnedModel && pinnedModel.toLowerCase() !== "auto";
    if (wantPin) {
      // A pinned model can be a subscription SEAT (run via the vendor binary) or
      // an in-loop model — resolve to the right selector so the pin is honored.
      const seat = subscriptionSeats().find((s) => [s.spec.id, s.spec.sdkId, s.canonicalId].includes(pinnedModel!));
      choice = seat
        ? new SubscriptionPinSelector(seat.account.id, seat.spec.sdkId ?? seat.spec.id).select({ prompt })
        : new FixedSelector(pinnedModel).select({ prompt });
    } else {
      try {
        choice = new RoutingSelector().select({ prompt, requires: ["tools"], interactive: true });
      } catch {
        choice = new RoutingSelector().select({ prompt }); // subscription-only setups
      }
    }
    // A CLI seat hosts the one-shot via the vendor binary.
    if (choice.backend?.kind === "cli") {
      const { runCliTask } = await import("./agent/cli-backend.ts");
      let out = "";
      const r = await runCliTask({
        binary: choice.backend.binary, profile: choice.backend.profile, prompt, messages: [],
        modelId: choice.model.sdkId ?? choice.model.id, effort: effort ?? choice.effort,
        onEvent: (e) => { if (e.type === "text") out += e.text; }, deferTerminal: true, autoApprove: yolo,
        // The in-loop path enforces read-only via the toolset (plan: !yolo); a
        // vendor CLI owns its own tools, so the equivalent must ride its flags
        // (claude --permission-mode plan / codex --sandbox read-only).
        readOnly: !yolo,
      });
      if (r.failure) { console.error(r.failure.message); process.exit(1); }
      console.log(jsonOut ? JSON.stringify({ text: out.trim(), model: choice.model.id, usage: r.usage }) : out.trim());
      process.exit(0);
    }
    const acct = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
    const creds = acct ? await resolveCreds(acct) : undefined;
    const { system, messages, cacheBreak } = buildContext({ history: [], userText: prompt, model: choice.model, plan: !yolo });
    let out = "";
    const r = await runTask({
      model: choice.model, messages, system, creds, cacheBreak, plan: !yolo,
      effort: effort ?? choice.effort,
      onEvent: (e) => { if (e.type === "text") out += e.text; else if (e.type === "error") console.error(e.message); },
      maxRetries: 2, deferTerminal: true,
    });
    recordSpend({
      accountId: acct?.id ?? `env:${choice.model.provider}`, model: choice.model.id, source: "turn",
      inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
      ...resolveTurnCost({ modelId: choice.model.id, isSub: false, usage: r.usage }), at: Date.now(),
    });
    if (r.failure) { console.error(r.failure.message); process.exit(1); }
    console.log(jsonOut ? JSON.stringify({ text: out.trim(), model: choice.model.id, usage: r.usage }) : out.trim());
    process.exit(0);
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
}

if (args[0] === "mcp") {
  const { addMcpServer, formatMcpConfigList, mcpToolSummary, mcpConfigPaths, removeMcpServer } = await import("./mcp.ts");
  const sub = args[1] ?? "list";
  if (sub === "list" || sub === "tools") {
    if (sub === "tools") console.log(await mcpToolSummary());
    else console.log(formatMcpConfigList());
  } else if (sub === "paths") {
    console.log(mcpConfigPaths().join("\n"));
  } else if (sub === "add") {
    const global = args[2] === "--global";
    const offset = global ? 3 : 2;
    try {
      console.log(addMcpServer(args[offset] ?? "", args[offset + 1] ?? "", args.slice(offset + 2), { scope: global ? "global" : "project" }));
    } catch (e: any) {
      console.log(e?.message ?? String(e));
      console.log("example: gearbox mcp add github npx -y @modelcontextprotocol/server-github");
      process.exit(1);
    }
  } else if (sub === "remove" || sub === "rm") {
    const global = args[2] === "--global";
    console.log(removeMcpServer(args[global ? 3 : 2] ?? "", { scope: global ? "global" : undefined }));
  } else {
    console.log("gearbox mcp [list|tools|paths|add <name> <command> [args...]|remove <name>]");
  }
  process.exit(0);
}

if (args[0] === "doctor") {
  const sub = args[1] ?? "models";
  if (sub === "live" || args.includes("--live")) {
    // One tiny REAL call per account — the matrix of what actually works
    // right now, with the fix command on every failing row.
    const { liveCheckAll, formatDoctorRows } = await import("./accounts/doctor.ts");
    console.log("live-checking every account (one ~8-token call each)…\n");
    const rows = await liveCheckAll((r) => {
      const mark = r.ok ? paint("32", "✓") : paint("31", "✗");
      console.log(`${mark} ${r.account.padEnd(20)} ${r.model.padEnd(24)} ${r.ok ? `ok${r.ms != null ? ` · ${r.ms}ms` : ""}` : `${r.state} · ${r.message ?? ""}`}`);
      if (!r.ok && r.fix) console.log(`    ${paint("36", "fix:")} ${r.fix}`);
    });
    const okCount = rows.filter((r) => r.ok).length;
    console.log(`\n${okCount}/${rows.length} working`);
    process.exit(okCount === rows.length ? 0 : 1);
  }
  if (sub === "models" || sub === "providers") {
    const { formatCapabilityMatrix } = await import("./model/capabilities.ts");
    console.log(formatCapabilityMatrix());
  } else {
    console.log("gearbox doctor [models|providers|live]");
  }
  process.exit(0);
}

// `gearbox auth …` — headless account/credential management (no TUI). Mirrors
// the in-app /accounts command so you can set up keys from a script or SSH.
if (args[0] === "auth") {
  const { listAccounts, loadAccounts, removeAccount } = await import("./accounts/store.ts");
  const { importableEnvCreds, importEnvCred, importableCloudCreds, importCloudCred } = await import("./accounts/detect.ts");
  const { addApiKeyAccount, addByPastedKey, addOpenAICompatAccount, testAccount, addableProviders, addCliAccount, cliAuthStatus, cliLoginArgs } = await import("./accounts/onboard.ts");
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
      : ["openai-compat", "openai-compatible", "custom", "proxy"].includes(head)
        ? await addOpenAICompatAccount(rest[1] ?? "", rest[2] ?? "", rest[3] ?? "", rest.slice(4))
      : rest[0] && !rest[1] && detectProviderByKey(rest[0])
        ? await addByPastedKey(rest[0])
        : rest[0] && rest[1]
          ? await addApiKeyAccount(rest[0], rest[1])
          : { ok: false, message: "usage: gearbox auth add <key>   |   gearbox auth add <provider> <key>   |   gearbox auth add openai-compat <name> <base-url> <key> <model>   |   gearbox auth add codex [name]" };
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

// Fullscreen is the DEFAULT: fixed frame + pinned composer, like a coding IDE.
// Use --inline or /config inline on for terminal-scrollback mode.
const uiPrefs = loadPrefs();
// Apply the saved palette BEFORE the first paint so even the banner is themed.
// No saved choice → ask the TERMINAL what its background is (OSC 11, bounded
// at ~150ms) and default to the light palette on a white terminal — the dark
// palette is unreadable there (user-reported). An explicit /theme choice
// always wins and skips the probe entirely.
if (uiPrefs.theme) {
  setTheme(uiPrefs.theme);
} else if (process.stdout.isTTY) {
  const { queryTerminalBackground } = await import("./ui/term-bg.ts");
  const bg = await queryTerminalBackground();
  if (bg === "light") setTheme("light");
}
const explicitInline = args.includes("--inline") || process.env.GEARBOX_INLINE === "1" || process.env.GEARBOX_FULLSCREEN === "0";
const explicitFullscreen = args.includes("--fullscreen") || process.env.GEARBOX_FULLSCREEN === "1";
const wantsInline = explicitInline || (!explicitFullscreen && uiPrefs.fullscreen === false);
const wantsFullscreen = !wantsInline;
const fullscreen = Boolean(process.stdout.isTTY) && wantsFullscreen;
// Mouse reporting is FULLSCREEN-ONLY. Grabbing the mouse (1000/1002/1006) is what
// powers wheel-scroll + click-to-select in the alt-screen Viewport — but it also
// DISABLES the terminal's own selection. In inline mode there's no Viewport to
// drive, so grabbing the mouse there just broke native double-click-drag selection
// (and scrollback) for no gain. Leave it off inline so the terminal selects natively.
const mouse = fullscreen && process.env.GEARBOX_MOUSE !== "0";
let restored = false;
const restore = () => {
  if (restored || !process.stdout.isTTY) return;
  restored = true;
  if (mouse) process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l"); // mouse reporting off
  process.stdout.write("\x1b[?2004l\x1b[?25h"); // bracketed paste off, cursor back on
  process.stdout.write("\x1b]2;\x07"); // reset the window/tab title (was left as "… · gearbox")
  // Leave the alt-screen so the PRE-LAUNCH normal buffer reappears intact. The old
  // "\x1b[2J\x1b[H" ran AFTER ?1049l, clearing the restored normal buffer — that
  // was the "screenful of empty space after exit" (viii). Don't touch it.
  if (fullscreen) process.stdout.write("\x1b[?1049l");
};

// A small parting card printed to the NORMAL buffer on a clean quit (after the
// alt-screen is gone), so it persists in scrollback: the wordmark, a one-line
// recap, and the exact command to pick up where you left off.
const gradientWord = (word: string): string => {
  if (!supportsAnsi) return word;
  const stops = wordmarkGradient.map(hexRgb);
  const at = (i: number) => {
    const t = word.length <= 1 ? 0 : (i / (word.length - 1)) * (stops.length - 1);
    const lo = Math.floor(t), hi = Math.min(stops.length - 1, lo + 1), f = t - lo;
    const c = [0, 1, 2].map((k) => Math.round(stops[lo]![k]! + (stops[hi]![k]! - stops[lo]![k]!) * f));
    return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${word[i]}`;
  };
  return "\x1b[1m" + word.split("").map((_, i) => at(i)).join("") + "\x1b[0m";
};
let goodbyeShown = false;
const printGoodbye = () => {
  if (goodbyeShown || !process.stdout.isTTY) return;
  goodbyeShown = true;
  try {
    const dim = supportsAnsi ? "\x1b[2m" : "";
    const rst = supportsAnsi ? "\x1b[0m" : "";
    const s = latestSession();
    let out = `\n  ${gradientWord("gearbox")}${dim}  ·  see you soon${rst}\n`;
    if (s && s.turns && s.turns.length) {
      const turns = s.turns.length;
      const tokens = s.turns.reduce((n, t) => n + (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cachedInputTokens || 0), 0);
      const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
      const mins = Math.max(1, Math.round((s.updatedAt - s.createdAt) / 60000));
      const title = ((s.title || "").replace(/\s+/g, " ").trim().slice(0, 50)) || "untitled session";
      out += `\n  ${accent("◇")} ${title}\n`;
      out += `    ${dim}${turns} turn${turns === 1 ? "" : "s"} · ${tok} tokens · ${mins}m${rst}\n`;
      out += `\n  ${dim}resume →${rst} ${accent("gearbox --continue")}${dim}   (or /resume to pick one)${rst}\n\n`;
    } else {
      out += "\n";
    }
    process.stdout.write(out);
  } catch { /* a goodbye must never block or crash the exit */ }
};
// Ensure restore runs even on uncaught errors or signals — including SIGINT and
// SIGHUP (terminal closed), which were missing, so a signal exit left the alt
// screen up / cursor hidden / title stuck. (raw mode means in-app ⌃C is a
// keypress, not SIGINT, so this doesn't change the ⌃C behavior.)
process.once("exit", restore);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(sig, () => { restore(); process.exit(sig === "SIGINT" ? 130 : 0); });
}
// Bracketed paste ON: the terminal wraps a paste in \x1b[200~…\x1b[201~ so its
// newlines are literal (not Enter-presses that submit mid-paste) and the whole
// blob can be assembled + collapsed to a chip. The App strips the markers and
// buffers across chunks (see the paste assembly in useInput).
// Strip \x1b[3J (erase-scrollback) from everything we write in fullscreen. Ink's
// ansi-escapes `clearTerminal` is "\x1b[2J\x1b[3J\x1b[H" and it fires that on every
// render once a frame is as tall as the screen — the 3J wipes the terminal's
// SCROLLBACK, so leaving the alt-screen on exit showed a blank pre-launch screen.
// We never want to erase the user's scrollback; a 2J+H full redraw is harmless.
// (The App also under-fills by a row so this rarely triggers; this is the guard.)
if (fullscreen && process.stdout.isTTY) {
  const rawWrite = process.stdout.write.bind(process.stdout) as (chunk: any, ...rest: any[]) => boolean;
  process.stdout.write = function (chunk: any, ...rest: any[]): boolean {
    if (typeof chunk === "string" && chunk.includes("\x1b[3J")) chunk = chunk.replaceAll("\x1b[3J", "");
    return rawWrite(chunk, ...rest);
  } as typeof process.stdout.write;
}
if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h\x1b[?25l");
if (fullscreen) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
if (mouse) process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");

// exitOnCtrlC:false so the app can handle ⌃C itself (interrupt / clear / confirm-quit).
// Fullscreen mounts the CONDUCTOR (parallel session tabs — /tab, ⌃T); inline
// keeps the single bare App (no alt-screen to multiplex).
const app = render(
  fullscreen
    ? <Conductor selector={selector} makeSelector={() => new RoutingSelector()} fullscreen resumeId={resumeId} />
    : <App selector={selector} fullscreen={fullscreen} resumeId={resumeId} />,
  { exitOnCtrlC: false },
);
// Force the process down right after teardown. Background work keeps the event
// loop alive — un-unref'd probe/refresh intervals and, worst case, an in-flight
// usage-probe SUBPROCESS whose kill-guard is `timeoutMs + 6000` (~15s) — so without
// an explicit exit the shell prompt didn't come back for ~15s after quitting.
// stdout is a TTY here, so the restore + goodbye writes flush synchronously first.
app.waitUntilExit().then(
  () => { restore(); printGoodbye(); process.exit(0); },
  () => { restore(); process.exit(1); },
);
process.on("exit", restore);
