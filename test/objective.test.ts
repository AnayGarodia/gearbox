// The expected-cost-to-correct objective: ONE currency optimizing cost +
// latency + quality, with effort as the lever. No arbitrary quality bar — the
// right pick emerges from real quantities. These tests pin the PROPERTIES that
// define correct three-way optimization (deterministic, pure, fixture-driven).
import { test, expect } from "bun:test";
import { effectiveCost, type ObjectiveCandidate, type ObjectiveContext } from "../src/model/objective.ts";

// A baseline candidate; tests override one field at a time to isolate effects.
const cand = (o: Partial<ObjectiveCandidate> = {}): ObjectiveCandidate => ({
  inUSDPerMtok: 3, outUSDPerMtok: 15, quality: 0.8, tps: 80, ttftMs: 1500, outputFactor: 0.2, ...o,
});
const ctx = (o: Partial<ObjectiveContext> = {}): ObjectiveContext => ({
  estInputTokens: 16_000, difficulty: 0, verifierTier: "tests", interactive: false, repoFailRate: undefined, ...o,
});
const E = (c: Partial<ObjectiveCandidate>, x: Partial<ObjectiveContext> = {}) => effectiveCost(cand(c), ctx(x)).total;

test("all else equal, the cheaper model has lower expected cost", () => {
  expect(E({ inUSDPerMtok: 1, outUSDPerMtok: 5 })).toBeLessThan(E({ inUSDPerMtok: 5, outUSDPerMtok: 25 }));
});

test("WITH a test net, a cheaper slightly-lower-quality model beats an expensive one (a miss is cheap to catch)", () => {
  const cheap = E({ inUSDPerMtok: 1, outUSDPerMtok: 5, quality: 0.75 }, { verifierTier: "tests" });
  const dear = E({ inUSDPerMtok: 5, outUSDPerMtok: 25, quality: 0.88 }, { verifierTier: "tests" });
  expect(cheap).toBeLessThan(dear);
});

test("with NO net, a clearly-higher-quality model wins when the gap justifies the price (a miss ships silently)", () => {
  // Same pair WITH a test net → cheap wins (a miss is caught); WITHOUT one → the
  // higher-quality model wins, because the proportional ship-wrong cost makes its
  // lower miss-rate worth the extra price. A wide quality gap at a moderate price
  // premium is exactly where caution should flip the pick.
  const cheap = E({ inUSDPerMtok: 1, outUSDPerMtok: 5, quality: 0.6 }, { verifierTier: "none", difficulty: 0.5 });
  const dear = E({ inUSDPerMtok: 4, outUSDPerMtok: 20, quality: 0.92 }, { verifierTier: "none", difficulty: 0.5 });
  expect(dear).toBeLessThan(cheap);
  // …and with a net the same cheap model wins (caution only emerges without one).
  const cheapNet = E({ inUSDPerMtok: 1, outUSDPerMtok: 5, quality: 0.6 }, { verifierTier: "tests", difficulty: 0.5 });
  const dearNet = E({ inUSDPerMtok: 4, outUSDPerMtok: 20, quality: 0.92 }, { verifierTier: "tests", difficulty: 0.5 });
  expect(cheapNet).toBeLessThan(dearNet);
});

test("difficulty raises the cost of a low-quality model more than a high-quality one", () => {
  const lowQ_easy = E({ quality: 0.72 }, { difficulty: 0, verifierTier: "none" });
  const lowQ_hard = E({ quality: 0.72 }, { difficulty: 1, verifierTier: "none" });
  const hiQ_hard = E({ quality: 0.92 }, { difficulty: 1, verifierTier: "none" });
  expect(lowQ_hard).toBeGreaterThan(lowQ_easy); // harder → likelier wrong → costlier
  expect(hiQ_hard).toBeLessThan(lowQ_hard); // on a hard task, quality is worth more
});

test("the pick is SCALE-INVARIANT: difficulty + verifier net decide it, not token count", () => {
  // The bug this guards against: a flat cost-of-wrong made tiny tasks over-route
  // to a premium model and huge tasks under-route to a cheap one. With both
  // recovery and ship-wrong per-Mtok, the winner must be the SAME across a 100×
  // token range — only difficulty and the net move it.
  const cheap = { inUSDPerMtok: 1, outUSDPerMtok: 5, quality: 0.6 };
  const dear = { inUSDPerMtok: 4, outUSDPerMtok: 20, quality: 0.92 };
  const winnerAt = (tokens: number, tier: "tests" | "none") =>
    E(cheap, { estInputTokens: tokens, difficulty: 0.5, verifierTier: tier }) <
    E(dear, { estInputTokens: tokens, difficulty: 0.5, verifierTier: tier })
      ? "cheap"
      : "dear";
  // No net + a real quality gap → the strong model wins at EVERY size.
  expect(winnerAt(4_000, "none")).toBe("dear");
  expect(winnerAt(40_000, "none")).toBe("dear");
  expect(winnerAt(400_000, "none")).toBe("dear");
  // With a net → the cheap model wins at EVERY size (a miss is caught).
  expect(winnerAt(4_000, "tests")).toBe("cheap");
  expect(winnerAt(400_000, "tests")).toBe("cheap");
});

test("latency only matters when interactive: a faster model wins when waiting, is neutral in background", () => {
  const fastI = E({ tps: 200, ttftMs: 500 }, { interactive: true });
  const slowI = E({ tps: 20, ttftMs: 8000 }, { interactive: true });
  expect(fastI).toBeLessThan(slowI); // waiting → speed counts
  const fastB = E({ tps: 200, ttftMs: 500 }, { interactive: false });
  const slowB = E({ tps: 20, ttftMs: 8000 }, { interactive: false });
  expect(Math.abs(fastB - slowB)).toBeLessThan(Math.abs(fastI - slowI)); // background → speed barely counts
});

test("a measured repo fail-rate raises expected cost (the flywheel feeds the same objective)", () => {
  const clean = E({ quality: 0.8 }, { repoFailRate: 0, verifierTier: "none" });
  const flaky = E({ quality: 0.8 }, { repoFailRate: 0.5, verifierTier: "none" });
  expect(flaky).toBeGreaterThan(clean);
});

test("a corrupt repo fail-rate (NaN / out of [0,1]) can't poison the objective", () => {
  // A NaN would otherwise survive the outer clamp and make total NaN; a negative
  // rate would silently understate risk below the no-evidence baseline.
  const baseline = E({ quality: 0.8 }, { repoFailRate: undefined, verifierTier: "none" });
  for (const bad of [NaN, -1, 2, Infinity]) {
    const r = effectiveCost(cand({ quality: 0.8 }), ctx({ repoFailRate: bad, verifierTier: "none" }));
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.wrongCost).toBeGreaterThanOrEqual(0);
  }
  // A clamped-to-1 rate is the worst case; it must not read as LESS risky than
  // having no measurement at all.
  const worst = E({ quality: 0.8 }, { repoFailRate: 2, verifierTier: "none" });
  expect(worst).toBeGreaterThanOrEqual(baseline);
});

test("breakdown exposes the three components for /why", () => {
  const r = effectiveCost(cand(), ctx({ interactive: true, verifierTier: "none" }));
  expect(r.dollars).toBeGreaterThan(0);
  expect(r.latencyCost).toBeGreaterThan(0);
  expect(r.wrongCost).toBeGreaterThan(0);
  expect(r.total).toBeCloseTo(r.dollars + r.latencyCost + r.wrongCost, 6);
});
