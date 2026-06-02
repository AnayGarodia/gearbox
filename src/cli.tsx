#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.tsx";
import { FixedSelector } from "./model/selector.ts";
import { anyProviderAvailable } from "./config.ts";
import { MODELS } from "./providers.ts";

const VERSION = "0.1.0";
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`gearbox ${VERSION} — multi-provider coding agent for the terminal

Usage:
  gearbox                 start in the current directory (it becomes the workspace)
  gearbox --model <name>  start with a specific model

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
