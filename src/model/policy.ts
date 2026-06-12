// Routing-policy registry — the one place a policy name becomes a selector.
// The default is the `combined` policy (the 3-part stack — fix-routing +
// verifier-tier-gated cheap-first + observable difficulty — plus thompson
// exploration and precedent), chosen on the strength of the routing bench
// (experiments/routing-bench; see experiments/FINDINGS.md Experiment 8):
// it matched the always-strong quality ceiling at ~25% lower cost and won the
// tested-repo and hard-task cases. `GEARBOX_ROUTER=baseline` restores the old
// classify→bar→cheapest router; any other name (or --router) selects a single
// policy, which is how the bench measures one at a time. An unknown EXPLICIT
// name throws so an experiment never silently measures the wrong policy.
const DEFAULT_POLICY = "combined";
import type { ModelSelector } from "./selector.ts";
import { RoutingSelector } from "./router.ts";
import { ExpectedCostSelector } from "./policies/expected-cost.ts";
import { PrecedentSelector } from "./policies/precedent.ts";
import { ThompsonSelector } from "./policies/thompson.ts";
import { FixRoutingSelector } from "./policies/fix-routing.ts";
import { ObservablesSelector } from "./policies/observables.ts";
import { CascadeSelector } from "./policies/cascade.ts";
import { CombinedSelector } from "./policies/combined.ts";
import { FixedStrongSelector, FixedCheapSelector, RandomSelector } from "./policies/anchors.ts";

const FACTORIES: Record<string, (fallbackId?: string) => ModelSelector> = {
  "baseline": (f) => new RoutingSelector(f),
  "expected-cost": (f) => new ExpectedCostSelector(f),
  "precedent": (f) => new PrecedentSelector(f),
  "thompson": (f) => new ThompsonSelector(f),
  "fix-routing": (f) => new FixRoutingSelector(f),
  "observables": (f) => new ObservablesSelector(f),
  "selfverify": (f) => new CascadeSelector("selfverify", f),
  "draft-review": (f) => new CascadeSelector("draft-review", f),
  "combined": (f) => new CombinedSelector(f),
  // Bench anchors (reference points, not recommended for daily use):
  "fixed-strong": (f) => new FixedStrongSelector(f),
  "fixed-cheap": (f) => new FixedCheapSelector(f),
  "random": (f) => new RandomSelector(f),
};

export function policyNames(): string[] {
  return Object.keys(FACTORIES);
}

/** The active policy name: explicit arg > GEARBOX_ROUTER > the default stack. */
export function activePolicyName(explicit?: string | null): string {
  return (explicit ?? process.env.GEARBOX_ROUTER ?? DEFAULT_POLICY).toLowerCase().trim() || DEFAULT_POLICY;
}

/** Selector for a policy name. Throws on an unknown explicit name so an
 *  experiment never silently measures the wrong policy. */
export function selectorForPolicy(name?: string | null, fallbackId?: string): ModelSelector {
  const n = activePolicyName(name);
  const make = FACTORIES[n];
  if (!make) throw new Error(`unknown routing policy "${n}" — one of: ${policyNames().join(", ")}`);
  return make(fallbackId);
}
