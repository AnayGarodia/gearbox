// Shared math for the routing policies. Everything here is pure given its
// arguments (countsFor/priorFor read the cached priors file, same as the base
// router does), so policies stay small and the interesting decisions are
// testable without accounts or a network.
import { type Candidate, qualityOf, costPair } from "../router.ts";
import { priorFor, countsFor } from "../priors.ts";

/** Blended per-turn cost estimate in USD — same shape the scorer uses
 *  (input-dominated agent turns, output ≈ 20% of input). */
export function costEstOf(c: Candidate, estInputTokens: number): number {
  const { inUSDPerMtok, outUSDPerMtok } = costPair(c);
  return (estInputTokens / 1e6) * inUSDPerMtok + ((0.2 * estInputTokens) / 1e6) * outUSDPerMtok;
}

/** Prior-adjusted quality — static benchmark + the measured per-repo delta. */
export function adjQualityOf(kind: string, c: Candidate): number {
  return qualityOf(c) + (priorFor(kind, c.canonicalId ?? c.spec.id)?.delta ?? 0);
}

/** Estimated probability this candidate FAILS verification on this kind of
 *  task in this repo. Measured counts win when present (Laplace-smoothed,
 *  /undo double-weighted); otherwise seeded from the static quality number —
 *  quality is SWE-bench-ish (hard tasks), so everyday turns get a +0.15 lift
 *  before inversion, clamped to [0.05, 0.9] so no candidate is ever treated
 *  as certain either way. */
export function pFailOf(kind: string, c: Candidate, repo?: string): number {
  const counts = countsFor(kind, c.canonicalId ?? c.spec.id, repo);
  if (counts) {
    const fails = counts.failed + 2 * counts.undone;
    const n = counts.passed + counts.failed + counts.undone;
    if (n >= 3) return Math.min(0.95, Math.max(0.02, (fails + 1) / (counts.passed + fails + 2)));
  }
  const q = qualityOf(c);
  return Math.min(0.9, Math.max(0.05, 1 - (q + 0.15)));
}

/** Strongest candidate by prior-adjusted quality; ties go to the cheaper one
 *  then lexicographic id, so the result is deterministic. */
export function strongestOf(pool: Candidate[], kind: string, estInputTokens: number): Candidate | undefined {
  return [...pool].sort(
    (a, b) =>
      adjQualityOf(kind, b) - adjQualityOf(kind, a) ||
      costEstOf(a, estInputTokens) - costEstOf(b, estInputTokens) ||
      a.spec.id.localeCompare(b.spec.id),
  )[0];
}

/** Cheapest candidate whose prior-adjusted quality clears `qFloor`; ties go to
 *  higher quality then id. Undefined when nothing clears the floor. */
export function cheapestAbove(pool: Candidate[], kind: string, qFloor: number, estInputTokens: number): Candidate | undefined {
  return pool
    .filter((c) => adjQualityOf(kind, c) >= qFloor)
    .sort(
      (a, b) =>
        costEstOf(a, estInputTokens) - costEstOf(b, estInputTokens) ||
        adjQualityOf(kind, b) - adjQualityOf(kind, a) ||
        a.spec.id.localeCompare(b.spec.id),
    )[0];
}

/** Approximate Beta(a, b) sample via its normal approximation — plenty for
 *  probe selection (we need "usually picks the more promising candidate",
 *  not exact posterior math). rng injectable for tests. */
export function sampleBeta(a: number, b: number, rng: () => number = Math.random): number {
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  // Box-Muller for one standard normal draw.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(1, Math.max(0, mean + sd * z));
}
