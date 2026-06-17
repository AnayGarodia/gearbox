// The difficulty axis wired into the expected-cost engine: a harder code task
// (big working set / many files) climbs to a stronger model than an easy one,
// from non-LLM context signals alone — and cheap kinds are never touched.
// Isolated account store so picks are deterministic.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { recordTurnOutcome, clearPriorsCache } from "../src/model/priors.ts";

process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-diff-"));
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY"];
const saved: Record<string, string | undefined> = {};
function only(...present: string[]) {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const k of present) process.env[k] = "test-key";
}
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// Coarse capability tier of a model id, for "climbed to a stronger model" checks.
const tier = (id: string) => ({ "claude-haiku-4-5": 1, "deepseek-v4-flash": 1, "deepseek-v4-pro": 1, "claude-sonnet-4-6": 2, "gpt-5.5": 2, "claude-opus-4-8": 3 } as Record<string, number>)[id] ?? 0;
const pick = (t: Parameters<RoutingSelector["select"]>[0]) => new RoutingSelector().select(t).model.id;

test("a hard code task with no net routes to a strong model, never weaker than the easy baseline (token cost held equal)", () => {
  only("ANTHROPIC_API_KEY");
  // estTokens held EQUAL so only the difficulty signal (file count) varies — a
  // bigger working set would otherwise raise the expensive model's dollar cost,
  // which is a separate (also real) effect we don't want to confound here.
  const easy = pick({ prompt: "fix it", kind: "code", verifierTier: "none", estTokens: 16_000, touchedFiles: ["a.ts"] });
  const hard = pick({ prompt: "fix it", kind: "code", verifierTier: "none", estTokens: 16_000, touchedFiles: Array.from({ length: 20 }, (_, i) => `module-${i}.ts`) });
  expect(tier(hard)).toBeGreaterThanOrEqual(tier(easy));
  expect(tier(hard)).toBeGreaterThanOrEqual(2); // a hard, unnetted code task earns a strong model
});

test("a measured high repo fail-rate routes a COLD code task stronger (repoFailRate→difficulty)", () => {
  only("ANTHROPIC_API_KEY");
  // Identical small, unnetted task each time — only the flywheel signal changes.
  const task = { prompt: "fix it", kind: "code" as const, verifierTier: "none" as const, estTokens: 16_000, touchedFiles: ["a.ts"] };
  const baseline = pick(task);
  // Seed ≥MIN_N failed outcomes ACROSS models (default repo slug) so the repo
  // reads as hard for EVERYONE — none of these model ids is a routing candidate,
  // so the per-model failRate path stays silent and only the repo-aggregate moves.
  for (let i = 0; i < 8; i++) recordTurnOutcome({ kind: "code", modelId: `seed-${i % 2}`, outcome: "failed" });
  clearPriorsCache();
  const hard = pick(task);
  expect(tier(hard)).toBeGreaterThanOrEqual(tier(baseline)); // never weaker
  expect(tier(hard)).toBeGreaterThanOrEqual(2); // a repo that fails everyone earns a strong model
  clearPriorsCache(); // don't leak the seeded priors into sibling tests
});

test("difficulty never touches a cheap kind — chat picks the cheapest regardless of heavy signals", () => {
  only("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY");
  const base = pick({ prompt: "what is a closure", kind: "chat" });
  const withSignals = pick({
    prompt: "what is a closure", kind: "chat",
    estTokens: 50_000, touchedFiles: Array.from({ length: 20 }, (_, i) => `m-${i}.ts`),
  });
  expect(withSignals).toBe(base);
});

test("a hard-WORDED code task climbs to a strong model EVEN WITH a test net — the user's nano/haiku bug", () => {
  only("ANTHROPIC_API_KEY");
  // Same files, same tokens, same net — ONLY the prompt words differ. The size
  // signals are identical (1 small file), so any climb is purely the semantic
  // read of the prompt biting through the soft objective under a "tests" net.
  const easy = pick({ prompt: "fix the typo in the readme", kind: "code", verifierTier: "tests", estTokens: 16_000, touchedFiles: ["a.ts"] });
  const hard = pick({ prompt: "fix the race condition in the connection pool", kind: "code", verifierTier: "tests", estTokens: 16_000, touchedFiles: ["a.ts"] });
  expect(tier(easy)).toBe(1); // easy + a net → cheapest capable (haiku)
  expect(tier(hard)).toBeGreaterThanOrEqual(2); // hard climbs to sonnet+ despite the test net
});
