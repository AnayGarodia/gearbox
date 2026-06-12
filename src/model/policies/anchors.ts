// Experiment anchors — not real policies, but the reference points the
// routing bench needs to place every policy on the cost-quality plane:
//   fixed-strong  the quality ceiling (and cost ceiling): always the strongest
//   fixed-cheap   the cost floor (and quality floor): always the cheapest
//   random        the sanity anchor: any policy must beat a uniform pick
// All three still go through prepare() so capability/context/cooldown
// filtering matches what real policies see.
import { RoutingSelector } from "../router.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { strongestOf, cheapestAbove } from "./util.ts";

export class FixedStrongSelector extends RoutingSelector {
  override readonly policyName: string = "fixed-strong";

  override select(task: Task): ModelChoice {
    const p = this.prepare(task);
    if (!p.pool.length) return super.select(task);
    const top = strongestOf(p.pool, p.kind, p.estInputTokens)!;
    const choice: ModelChoice = { model: top.spec, reason: `${p.kind} · anchor: strongest available`, backend: top.backend };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, p.pool, p);
    return choice;
  }
}

export class FixedCheapSelector extends RoutingSelector {
  override readonly policyName: string = "fixed-cheap";

  override select(task: Task): ModelChoice {
    const p = this.prepare(task);
    if (!p.pool.length) return super.select(task);
    const cheap = cheapestAbove(p.pool, p.kind, 0, p.estInputTokens)!;
    const choice: ModelChoice = { model: cheap.spec, reason: `${p.kind} · anchor: cheapest available`, backend: cheap.backend };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, p.pool, p);
    return choice;
  }
}

export class RandomSelector extends RoutingSelector {
  override readonly policyName: string = "random";

  constructor(fallbackId?: string, private rng: () => number = Math.random) {
    super(fallbackId);
  }

  override select(task: Task): ModelChoice {
    const p = this.prepare(task);
    if (!p.pool.length) return super.select(task);
    const pick = p.pool[Math.min(p.pool.length - 1, Math.floor(this.rng() * p.pool.length))]!;
    const choice: ModelChoice = { model: pick.spec, reason: `${p.kind} · anchor: uniform random`, backend: pick.backend };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, p.pool, p);
    return choice;
  }
}
