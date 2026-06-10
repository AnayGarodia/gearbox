import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { scorecardRows } from "../src/commands.ts";
import type { Scorecard, ScorecardEntry } from "../src/model/selector.ts";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-card-"));
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.DEEPSEEK_API_KEY = "k";
});
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

test("explain() ranks candidates, marks exactly one chosen, and it matches select()", () => {
  const r = new RoutingSelector();
  const task = { prompt: "refactor the parser" };
  const card = r.explain(task);
  const chosen = card.entries.filter((e) => e.chosen);
  expect(chosen.length).toBe(1);
  expect(chosen[0]!.label).toBe(r.select(task).model.label); // scorecard agrees with the real pick
  expect(card.kind).toBe("code");
  expect(card.bar).toBeCloseTo(0.7, 5);
});

test("below-bar candidates are shown but never chosen, with provenance tags", () => {
  const card = new RoutingSelector().explain({ prompt: "refactor the parser" });
  const haiku = card.entries.find((e) => e.label.includes("haiku"));
  expect(haiku?.verdict).toBe("below bar"); // haiku quality < 0.7
  expect(haiku?.chosen).toBe(false);
  // every entry carries a provenance abbreviation
  for (const e of card.entries) expect(["measured", "researched", "seeded"]).toContain(e.qualitySrc);
});

// Regression: explain() used to drop `interactive` (and warm) from its scoring
// call while select() passed them, so /why could show a different winner than
// the actual pick. Both must score with the same flags.
test("explain agrees with select under warm + interactive", () => {
  const r = new RoutingSelector();
  // First pick establishes the selector's own warm memory (the default warm).
  r.select({ prompt: "refactor the parser" });
  const task = { prompt: "refactor the parser", interactive: true };
  const chosen = r.explain(task).entries.filter((e) => e.chosen);
  expect(chosen.length).toBe(1);
  expect(chosen[0]!.label).toBe(r.select(task).model.label);

  // An explicitly supplied task.warm is honored the same way by both paths.
  const warmTask = { prompt: "refactor the parser", interactive: true, warm: { accountId: "env:deepseek", modelId: "deepseek-v4-pro" } };
  expect(r.explain(warmTask).entries.find((e) => e.chosen)!.label).toBe(r.select(warmTask).model.label);
});

// The selector remembers its own last pick as the default warm: after a select,
// every OTHER candidate is charged the switch penalty, so the same candidate
// scores higher (worse) on a warmed selector than on a cold one.
test("the selector's own last pick acts as the default warm for the next turn", () => {
  const task = { prompt: "refactor the parser" };
  const cold = new RoutingSelector().explain(task); // no pick yet → no warm → no switch penalty
  const warmed = new RoutingSelector();
  expect(warmed.select(task).model.id).toBe("deepseek-v4-pro"); // establishes warm
  const after = warmed.explain(task);
  const score = (card: ReturnType<RoutingSelector["explain"]>, label: string) =>
    card.entries.find((e) => e.label === label)!.score;
  // The warm model's score is unchanged; a cold sibling now pays the penalty.
  expect(score(after, "sonnet-4.6")).toBeGreaterThan(score(cold, "sonnet-4.6"));
  expect(score(after, "deepseek-v4-pro")).toBeCloseTo(score(cold, "deepseek-v4-pro"), 10);
});

test("scorecardRows renders a title, a column header, and one row per candidate", () => {
  const card = new RoutingSelector().explain({ prompt: "refactor the parser" });
  const rows = scorecardRows(card);
  expect(rows[0]!.tone).toBe("title");
  expect(rows.some((r) => r.tone === "colhead")).toBe(true);
  expect(rows.some((r) => r.tone === "chosen" && r.text.includes("◀"))).toBe(true);
});

// A hand-built card with the shapes that confused real users: the same model on
// a subscription seat AND a metered key, a seeded below-bar row, a measured prior.
const entry = (over: Partial<ScorecardEntry>): ScorecardEntry => ({
  label: "sonnet-4.6",
  backend: "api",
  quality: 0.77,
  qualitySrc: "researched",
  estCostPerMtok: 6,
  score: 0.1,
  chosen: false,
  verdict: "ok",
  ...over,
});
const fixtureCard = (): Scorecard => ({
  kind: "code",
  bar: 0.7,
  prompt: "WHat is capital of India",
  entries: [
    entry({ backend: "seat", accountLabel: "claude-max", headroomPct: 34, score: 0, chosen: true, verdict: "chosen", priorNote: "measured here: 7/9 ✓ (−0.04)" }),
    entry({ label: "opus-4.8", backend: "seat", accountLabel: "claude-max", headroomPct: 34, quality: 0.83, estCostPerMtok: 10, score: 0.16, verdict: "seat ~free" }),
    entry({ balanceText: "$12.50" }),
    entry({ label: "haiku-4.5", quality: 0.38, qualitySrc: "seeded", estCostPerMtok: 2, verdict: "below bar" }),
  ],
});

test("scorecard speaks plainly: summary sentence, via column, honest seat cost, worded verdicts, legend", () => {
  const texts = scorecardRows(fixtureCard(), 80).map((r) => r.text);
  const all = texts.join("\n");
  // the plain-English "why" leads, and names the plan for a seat winner
  expect(all).toContain("picked sonnet-4.6 on your claude-max plan");
  // duplicate model rows are distinguishable: seat shows the account, api shows "api key"
  expect(all).toContain("claude-max");
  expect(all).toContain("api key");
  // seat rows cost "plan" (not the misleading metered price) and show window headroom
  expect(texts.some((t) => t.includes("claude-max") && t.includes("plan") && !t.includes("$10.00"))).toBe(true);
  expect(all).toContain("34% plan");
  // verdicts are words, not jargon
  expect(all).toContain("free on plan");
  expect(all).toContain("eligible");
  expect(all).toContain("under 0.70 bar");
  expect(all).not.toContain("seat ~free");
  expect(all).not.toContain("rsch");
  // the measured prior gets its own sub-line; seeded quality gets the ~ marker
  expect(texts.some((t) => t.trimStart().startsWith("↳ measured here"))).toBe(true);
  expect(all).toContain("0.38~");
  // the legend explains score and the left column
  expect(all).toContain("lowest eligible wins");
  expect(all).toContain("~ = estimated quality");
});

test("every scorecard line fits the given width", () => {
  for (const width of [80, 60]) {
    for (const r of scorecardRows(fixtureCard(), width)) {
      // name columns shrink to fit; only the verdict tail may ever exceed and
      // be clipped by the renderer — assert the table body itself fits
      expect(r.text.length).toBeLessThanOrEqual(width);
    }
  }
});

test("unknown router verdicts pass through verbatim", () => {
  const card = fixtureCard();
  card.entries[2] = entry({ verdict: "context too small" });
  const all = scorecardRows(card, 80).map((r) => r.text).join("\n");
  expect(all).toContain("context too small");
});

test("env-default candidates carry no accountLabel (rendered as 'api key')", () => {
  const card = new RoutingSelector().explain({ prompt: "refactor the parser" });
  const api = card.entries.filter((e) => e.backend === "api");
  expect(api.length).toBeGreaterThan(0);
  for (const e of api) expect(e.accountLabel).toBeUndefined();
});
