import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point GEARBOX_HOME at an empty temp dir BEFORE touching the registry so the
// test sees only the static catalog (no discovered account models, no
// models.dev overlay from the developer's real home).
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-drift-"));

import { modelRegistry } from "../src/providers.ts";
import { profileFor } from "../src/model/profiles.ts";

// Profile/registry drift guard: routing quality, cost, and tokenizer data all
// come from PROFILES, so a routable model without a profile routes on guesses
// (quality 0.5, sentinel cost). These ids are the KNOWN gaps as of 2026-06 —
// mostly seeded catalog examples for providers without a vetted profile yet.
// Adding a new routable model without a profile fails this test; write the
// profile instead of growing this list.
const KNOWN_GAPS = new Set([
  "gpt-5.5-pro",
  "deepseek-v4-flash",
  "openai/gpt-5.5-mini",
  "google/gemini-3.1-flash-lite",
  "xai/grok-4.3",
  "xai/grok-4.1-fast",
  "mistral/mistral-large-latest",
  "mistral/codestral-latest",
  "groq/llama-3.3-70b-versatile",
  "groq/qwen-qwq-32b",
  "groq/gemma2-9b-it",
  "together/deepseek-ai/DeepSeek-V3",
  "together/Qwen/Qwen2.5-Coder-32B-Instruct",
  "fireworks/accounts/fireworks/models/deepseek-v3",
  "cerebras/qwen-3-coder-480b",
  "cerebras/llama-3.3-70b",
  "perplexity/sonar-pro",
  "perplexity/sonar-reasoning-pro",
  "moonshot/kimi-k2-0905-preview",
  "zai/glm-4.6",
  "zai/glm-4.5-air",
  "minimax/MiniMax-Text-01",
  "minimax/MiniMax-M1",
  "ollama/qwen2.5-coder:7b",
  "ollama/llama3.3",
]);

test("every routable registry model has a profile (or is a known gap)", () => {
  const routable = modelRegistry().filter((m) => m.routable !== false);
  expect(routable.length).toBeGreaterThan(0);
  const missing = routable.filter((m) => !profileFor(m.id) && !KNOWN_GAPS.has(m.id)).map((m) => m.id);
  expect(missing).toEqual([]);
});

test("KNOWN_GAPS shrinks when a profile is added (no stale allowlist entries)", () => {
  const stale = [...KNOWN_GAPS].filter((id) => profileFor(id));
  expect(stale).toEqual([]);
});
