// thompson policy — verifier-gated exploration. The priors flywheel only ever
// learns about models that get PICKED: once a strong model wins code turns,
// Haiku/Flash never get a datapoint and the router can never learn they would
// have sufficed here. This policy occasionally PROBES one tier below the
// baseline winner — at a rate tied to verifier strength, because the VERIFY
// gate is what makes a failed probe cheap (it gets caught and escalated like
// any miss): ε = 0.15 with tests, 0.05 types-only, 0 with no verifier.
// WHICH cheaper candidate to probe is chosen by Thompson sampling over the
// Beta posterior of the stored outcome counts (quality-seeded pseudo-counts
// for cold starts), so probing concentrates on the most promising unknowns.
// The probe rate is enforced with a deterministic counter (every ⌈1/ε⌉-th
// eligible turn) so behavior is testable and self-capping.
import { RoutingSelector, qualityOf, type Candidate } from "../router.ts";
import { countsFor } from "../priors.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { adjQualityOf, costEstOf, sampleBeta } from "./util.ts";

const PROBE_FLOOR = 0.25; // never probe the bottom tier; its failures teach nothing new
const PROBE_MAX_COST = 0.8; // a probe must be meaningfully cheaper (≤80% of the winner's cost)
// Pseudo-observations a cold-start candidate carries into its Beta posterior:
// quality q seeds Beta(8q+1, 8(1−q)+1), i.e. "as if" 8 turns at the benchmark
// pass rate — enough to anchor sampling, weak enough that real outcomes
// dominate after a handful of probes.
const SEED_N = 8;

export class ThompsonSelector extends RoutingSelector {
  override readonly policyName: string = "thompson";
  private sinceProbe = 0;

  constructor(fallbackId?: string, private rng: () => number = Math.random) {
    super(fallbackId);
  }

  override select(task: Task): ModelChoice {
    const base = super.select(task); // logs itself under this.policyName
    if ((task.escalate ?? 0) > 0) return base; // never probe while fixing a miss
    const tier = task.verifierTier ?? "none";
    const eps = tier === "tests" ? 0.15 : tier === "types" ? 0.05 : 0;
    if (eps === 0) return base;
    const p = this.prepare(task);
    if (p.kind !== "code" && p.kind !== "plan") return base; // bounded sub-tasks are already cheapest
    const baseCand = p.pool.find((c) => c.spec.id === base.model.id);
    if (!baseCand || baseCand.backend.kind === "cli") return base; // a seat is ~free; probing can't save money
    this.sinceProbe++;
    if (this.sinceProbe < Math.round(1 / eps)) return base;

    const cBase = costEstOf(baseCand, p.estInputTokens);
    const probes = p.pool.filter(
      (c) =>
        c.spec.id !== base.model.id &&
        c.backend.kind !== "cli" &&
        adjQualityOf(p.kind, c) >= PROBE_FLOOR &&
        costEstOf(c, p.estInputTokens) < cBase * PROBE_MAX_COST,
    );
    if (!probes.length) return base;

    let pick: Candidate | null = null;
    let bestTheta = -1;
    for (const c of probes) {
      const counts = countsFor(p.kind, c.canonicalId ?? c.spec.id);
      const q = qualityOf(c);
      const a = (counts?.passed ?? 0) + q * SEED_N + 1;
      const b = (counts ? counts.failed + 2 * counts.undone : 0) + (1 - q) * SEED_N + 1;
      const theta = sampleBeta(a, b, this.rng);
      if (theta > bestTheta) {
        bestTheta = theta;
        pick = c;
      }
    }
    if (!pick) return base;
    this.sinceProbe = 0;
    const choice: ModelChoice = {
      model: pick.spec,
      reason: `${p.kind} · probe (thompson): testing a cheaper tier under the ${tier} verifier`,
      backend: pick.backend,
    };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, probes, p);
    return choice;
  }
}
