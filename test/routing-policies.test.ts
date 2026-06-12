// The routing policies behind GEARBOX_ROUTER: each one's signature decision,
// tested against the real registry with only Anthropic models available
// (sonnet wins baseline code; haiku is the cheap tier; opus the strong tier).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPriorsCache, recordTurnOutcome } from "../src/model/priors.ts";
import { clearCooldowns } from "../src/model/cooldown.ts";
import { clearOutcomesCache, recordRoutingOutcome, readRoutingOutcomes } from "../src/model/outcomes.ts";
import { readRouteDecisions } from "../src/model/route-log.ts";
import { selectorForPolicy, policyNames } from "../src/model/policy.ts";
import { ExpectedCostSelector } from "../src/model/policies/expected-cost.ts";
import { FixRoutingSelector } from "../src/model/policies/fix-routing.ts";
import { ThompsonSelector } from "../src/model/policies/thompson.ts";
import { PrecedentSelector } from "../src/model/policies/precedent.ts";
import { ObservablesSelector, kindFromSignals, difficultyBar } from "../src/model/policies/observables.ts";
import { CascadeSelector } from "../src/model/policies/cascade.ts";
import { CombinedSelector } from "../src/model/policies/combined.ts";
import { FixedStrongSelector, FixedCheapSelector, RandomSelector } from "../src/model/policies/anchors.ts";
import type { DifficultySignals } from "../src/model/selector.ts";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME", "GEARBOX_ROUTER"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-policies-"));
  process.env.ANTHROPIC_API_KEY = "k";
  clearPriorsCache();
  clearOutcomesCache();
  clearCooldowns();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  clearPriorsCache();
  clearOutcomesCache();
});

const CODE = { prompt: "refactor the parser to handle escapes", kind: "code" as const };

test("registry: every policy name resolves; unknown names throw", () => {
  for (const n of policyNames()) expect(selectorForPolicy(n)).toBeTruthy();
  expect(() => selectorForPolicy("nonsense")).toThrow(/unknown routing policy/);
});

// ── expected-cost ────────────────────────────────────────────────────────────

test("expected-cost: with a test verifier, the cheap draft wins when the math says so", () => {
  const r = new ExpectedCostSelector();
  // sonnet ($0.096/turn) is the baseline pick; haiku ($0.032) with seeded
  // p_fail ≈ 0.47 has E ≈ $0.085 < $0.096 → drafts cheap, gate catches a miss.
  const pick = r.select({ ...CODE, verifierTier: "tests" });
  expect(pick.model.id).toBe("claude-haiku-4-5");
  expect(pick.reason).toContain("expected-cost");
});

test("expected-cost: with NO verifier a miss is invisible → MORE caution than baseline", () => {
  const r = new ExpectedCostSelector();
  // bar 0.7 + 0.1 → sonnet (0.77) no longer clears; opus (0.83) does.
  const pick = r.select({ ...CODE, verifierTier: "none" });
  expect(pick.model.id).toBe("claude-opus-4-8");
});

test("expected-cost: escalation climbs through the baseline path (no second cheap draft)", () => {
  const r = new ExpectedCostSelector();
  const pick = r.select({ ...CODE, verifierTier: "tests", escalate: 1 });
  expect(pick.model.id).not.toBe("claude-haiku-4-5");
});

// ── fix-routing ──────────────────────────────────────────────────────────────

test("fix-routing: a typecheck failure routes DOWN (the compiler pinpointed it)", () => {
  const r = new FixRoutingSelector();
  const pick = r.select({ ...CODE, escalate: 1, failureKind: "typecheck" });
  expect(pick.model.id).toBe("claude-haiku-4-5");
  expect(pick.reason).toContain("routed down");
});

test("fix-routing: a test failure jumps straight to the strongest tier", () => {
  const r = new FixRoutingSelector();
  const pick = r.select({ ...CODE, escalate: 1, failureKind: "test" });
  expect(pick.model.id).toBe("claude-opus-4-8");
  expect(pick.reason).toContain("strongest tier");
});

test("fix-routing: no escalation → baseline behavior", () => {
  const r = new FixRoutingSelector();
  expect(r.select({ ...CODE, verifierTier: "tests" }).model.id).toBe("claude-sonnet-4-6");
});

// ── thompson ─────────────────────────────────────────────────────────────────

test("thompson: probes a cheaper tier at the verifier-gated rate, never unverified", () => {
  const r = new ThompsonSelector(undefined, () => 0.5);
  const picks: string[] = [];
  for (let i = 0; i < 14; i++) picks.push(r.select({ ...CODE, verifierTier: "tests" }).model.id);
  const probes = picks.filter((id) => id === "claude-haiku-4-5");
  expect(probes.length).toBe(2); // ε=0.15 → every 7th eligible turn
  expect(picks[6]).toBe("claude-haiku-4-5");

  const r2 = new ThompsonSelector(undefined, () => 0.5);
  for (let i = 0; i < 14; i++) expect(r2.select({ ...CODE, verifierTier: "none" }).model.id).toBe("claude-sonnet-4-6");
});

test("thompson: never probes while an escalation is fixing a miss", () => {
  const r = new ThompsonSelector(undefined, () => 0.5);
  for (let i = 0; i < 14; i++) {
    const pick = r.select({ ...CODE, verifierTier: "tests", escalate: 1 });
    expect(pick.reason).not.toContain("probe");
  }
});

// ── precedent ────────────────────────────────────────────────────────────────

test("precedent: a model that keeps failing on SIMILAR tasks sinks below the bar", () => {
  // Sonnet failed five near-identical parser tasks here → its local precedent
  // (-0.15) pulls 0.77 below the 0.7 bar → opus takes the work.
  for (let i = 0; i < 5; i++) {
    recordRoutingOutcome({
      kind: "code", modelId: "claude-sonnet-4-6", outcome: "failed",
      prompt: "refactor the parser to handle escapes",
      terms: ["refactor", "parser", "handle", "escapes"], touched: ["parser.ts"], policy: "test",
    });
  }
  clearOutcomesCache();
  const r = new PrecedentSelector();
  const pick = r.select(CODE);
  expect(pick.model.id).toBe("claude-opus-4-8");
});

test("precedent: no similar history → baseline pick", () => {
  const r = new PrecedentSelector();
  expect(r.select(CODE).model.id).toBe("claude-sonnet-4-6");
});

// ── observables ──────────────────────────────────────────────────────────────

const concentrated: DifficultySignals = { retrievalTop: 30, retrievalSpread: 3.2, filesMatched: 12, promptChars: 80, hasTests: true };
const diffuse: DifficultySignals = { retrievalTop: 8, retrievalSpread: 1.1, filesMatched: 200, promptChars: 2000, hasTests: false };

test("observables: pure helpers — kind and bar from repo signals, no model call", () => {
  expect(kindFromSignals(concentrated)).toBe("chat");
  expect(kindFromSignals(diffuse)).toBe("code");
  expect(difficultyBar(0.7, concentrated)).toBe(0.45);
  expect(difficultyBar(0.7, { ...concentrated, hasTests: false })).toBe(0.6);
  expect(difficultyBar(0.7, diffuse)).toBeCloseTo(0.8);
});

test("observables: a concentrated, tested task lowers the bar below sonnet", () => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "k"; // flash (0.48) clears a 0.45 bar
  const r = new ObservablesSelector();
  const pick = r.select({ ...CODE, difficulty: concentrated, verifierTier: "tests" });
  expect(pick.model.id).toBe("gemini-3.5-flash");
});

test("observables: a diffuse task raises the bar above sonnet", () => {
  const r = new ObservablesSelector();
  const pick = r.select({ ...CODE, difficulty: diffuse });
  expect(pick.model.id).toBe("claude-opus-4-8");
});

// ── cascades ─────────────────────────────────────────────────────────────────

test("cascade selectors draft cheap and escalate through the baseline climb", () => {
  for (const kind of ["selfverify", "draft-review"] as const) {
    const r = new CascadeSelector(kind);
    expect(r.cascade).toBe(kind);
    expect(r.select({ ...CODE, verifierTier: "none" }).model.id).toBe("claude-haiku-4-5");
    // Rejected draft → escalate 1 → bar 0.78 → only opus clears.
    expect(r.select({ ...CODE, verifierTier: "none", escalate: 1 }).model.id).toBe("claude-opus-4-8");
  }
});

// ── combined ─────────────────────────────────────────────────────────────────

test("combined: expected-cost cheap-first under tests; failure-kind routing on escalation", () => {
  const r = new CombinedSelector(undefined, () => 0.5);
  expect(r.select({ ...CODE, verifierTier: "tests", difficulty: concentrated }).model.id).toBe("claude-haiku-4-5");
  expect(r.select({ ...CODE, verifierTier: "tests", escalate: 1, failureKind: "typecheck" }).model.id).toBe("claude-haiku-4-5");
  expect(r.select({ ...CODE, verifierTier: "tests", escalate: 1, failureKind: "test" }).model.id).toBe("claude-opus-4-8");
});

// ── anchors ──────────────────────────────────────────────────────────────────

test("anchors: strongest / cheapest / random bound the experiment", () => {
  expect(new FixedStrongSelector().select(CODE).model.id).toBe("claude-opus-4-8");
  expect(new FixedCheapSelector().select(CODE).model.id).toBe("claude-haiku-4-5");
  const pick = new RandomSelector(undefined, () => 0).select(CODE);
  expect(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]).toContain(pick.model.id);
});

// ── instrumentation ──────────────────────────────────────────────────────────

test("every routed pick lands in the route-decision log with its policy name", () => {
  new FixedStrongSelector().select(CODE);
  new ExpectedCostSelector().select({ ...CODE, verifierTier: "tests" });
  const rows = readRouteDecisions();
  expect(rows.some((r) => r.policy === "fixed-strong")).toBe(true);
  expect(rows.some((r) => r.policy === "expected-cost")).toBe(true);
  expect(rows.every((r) => r.chosen.length > 0)).toBe(true);
});

test("outcome log: repo-scoped roundtrip with terms and touched files", () => {
  recordRoutingOutcome({ kind: "code", modelId: "m", outcome: "passed", prompt: "fix the cache", terms: ["fix", "cache"], touched: ["cache.ts"], policy: "baseline" });
  clearOutcomesCache();
  const rows = readRoutingOutcomes();
  expect(rows.length).toBe(1);
  expect(rows[0]!.terms).toEqual(["fix", "cache"]);
  expect(readRoutingOutcomes("some-other-repo").length).toBe(0);
});

test("priors: strong evidence (n≥10) may promote past the old +0.04 cap", () => {
  for (let i = 0; i < 30; i++) recordTurnOutcome({ kind: "code", modelId: "m", outcome: "passed", repo: "r" });
  clearPriorsCache();
  const { priorFor } = require("../src/model/priors.ts");
  expect(priorFor("code", "m", "r")!.delta).toBeGreaterThan(0.04);
});
