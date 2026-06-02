import { MODELS, type Model } from "./models.ts";
import type { Task } from "./tasks.ts";

export const costFor = (m: Model, t: Task) => (t.tokens / 1_000_000) * m.blendedUSDperMTok;
const adequate = (m: Model, t: Task) => m.quality[t.type] >= t.req;

// Marginal-benefit rule: among models that CLEAR the quality bar, the cheapest is
// optimal — quality above the requirement is wasted spend. This is the formal
// version of "is Opus actually better here, or am I overpaying?"
export function routeCheapestAdequate(t: Task): Model {
  const ok = MODELS.filter((m) => adequate(m, t));
  return ok.reduce((a, b) => (costFor(b, t) < costFor(a, t) ? b : a));
}

// Gearbox router: marginal-benefit + CREDIT scarcity. Spending a large fraction
// of a small balance is penalized, so the scarce OpenAI credit is preserved when
// a model drawing on a flush account clears the same bar at comparable cost.
const K_SCARCITY = 20;
export function routeGearbox(t: Task, balances: Record<string, number>): { model: Model; fallback: boolean } {
  const affordableAdequate = MODELS.filter((m) => adequate(m, t) && balances[m.provider] >= costFor(m, t));
  if (affordableAdequate.length) {
    const score = (m: Model) => {
      const c = costFor(m, t);
      return c + K_SCARCITY * (c / balances[m.provider]); // lower = better
    };
    const model = affordableAdequate.reduce((a, b) => (score(b) < score(a) ? b : a));
    return { model, fallback: false };
  }
  // no adequate+affordable model: fall back to best-quality affordable, flag it
  const affordable = MODELS.filter((m) => balances[m.provider] >= costFor(m, t));
  const pool = affordable.length ? affordable : MODELS;
  const model = pool.reduce((a, b) => (b.quality[t.type] > a.quality[t.type] ? b : a));
  return { model, fallback: true };
}

// transparency: full scored breakdown for one task (the "why")
export function explain(t: Task, balances: Record<string, number>) {
  return MODELS.map((m) => ({
    id: m.id,
    q: m.quality[t.type],
    clears: adequate(m, t),
    cost: costFor(m, t),
    balance: balances[m.provider],
    score: costFor(m, t) + K_SCARCITY * (costFor(m, t) / balances[m.provider]),
  })).sort((a, b) => a.score - b.score);
}
