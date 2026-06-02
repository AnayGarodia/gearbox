#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { App } from "./ui/App.tsx";
import { FixedSelector } from "./model/selector.ts";
import { anyProviderAvailable } from "./config.ts";
import { MODELS } from "./providers.ts";

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
  gearbox upgrade         pull the latest version + reinstall deps

Options:
  --model <name>   e.g. sonnet-4.6, haiku, gemini-flash, deepseek
  -v, --version    print version
  -h, --help       this help

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
const selector = new FixedSelector(preferred);

render(<App selector={selector} demo={demo} />);
