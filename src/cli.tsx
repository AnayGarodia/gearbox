#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { App } from "./ui/App.tsx";
import { FixedSelector } from "./model/selector.ts";
import { RoutingSelector } from "./model/router.ts";
import { anyProviderAvailable } from "./config.ts";
import { MODELS } from "./providers.ts";
import { detectImageMode, setImageMode, transmitAll } from "./ui/image.ts";
import { setYolo } from "./permission.ts";
import { latestSession } from "./session.ts";

const VERSION = "0.1.0";
const args = process.argv.slice(2);

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
  gearbox --model <name>  start with a specific model
  gearbox --continue      resume the most recent session in this directory
  gearbox upgrade         pull the latest version + reinstall deps

Options:
  --model <name>      e.g. sonnet-4.6, haiku, gemini-flash, deepseek
  -c, --continue      resume the most recent session here (/resume to pick one)
  --yolo              auto-approve writes/edits/shell (no permission prompts)
  -v, --version       print version
  -h, --help          this help

Set at least one provider key first (each user uses their own):
  ANTHROPIC_API_KEY · OPENAI_API_KEY · GOOGLE_GENERATIVE_AI_API_KEY · DEEPSEEK_API_KEY

Models: ${MODELS.map((m) => m.label).join(", ")}
In-app: / for commands, @ for files, !cmd for shell, shift+tab for plan mode.`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

const mi = args.indexOf("--model");
const preferred = mi >= 0 ? args[mi + 1] : undefined;
const demo = !anyProviderAvailable();
// Routing is the default (the product's point: pick the model per task). An
// explicit --model pins one model (FixedSelector) and turns routing off; switch
// back in-app with `/model auto`.
const selector = preferred ? new FixedSelector(preferred) : new RoutingSelector();
if (args.includes("--yolo")) setYolo(true); // start with writes/edits/shell auto-approved
// --continue / -c resumes the most recent session for this directory.
const resumeId = args.includes("--continue") || args.includes("-c") ? (latestSession()?.id ?? undefined) : undefined;

// Resolve how Boo renders, once, and share it with the UI.
const imageMode = detectImageMode();
setImageMode(imageMode);

// kitty/Ghostty: transmit the PNGs once (only when GEARBOX_GHOST=kitty is opted in);
// the UI references them via cheap Unicode placeholders (a=T,U=1 draws nothing).
if (process.stdout.isTTY && imageMode === "kitty") process.stdout.write(transmitAll());

// Fullscreen via the alternate screen buffer: the app owns the screen, the input
// is pinned to the bottom, and the transcript is a virtualized scroll region (it
// renders only the visible lines, so the frame never exceeds the screen). Restore
// the main screen on every exit path. GEARBOX_INLINE=1 forces plain inline flow.
const fullscreen = Boolean(process.stdout.isTTY) && process.env.GEARBOX_INLINE !== "1";
const restore = () => {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?2004l"); // bracketed paste off
  if (fullscreen) process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l\x1b[?25h");
};
// Bracketed paste so multi-line paste arrives as one chunk (not \r-per-line that
// would submit on each newline). alt-screen + SGR mouse reporting for fullscreen.
if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");
if (fullscreen) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h");

// exitOnCtrlC:false so the app can handle ⌃C itself (interrupt / clear / confirm-quit).
const app = render(<App selector={selector} demo={demo} fullscreen={fullscreen} resumeId={resumeId} />, { exitOnCtrlC: false });
app.waitUntilExit().then(restore, restore);
process.on("exit", restore);
