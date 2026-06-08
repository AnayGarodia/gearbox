// Pure logic for the Cost tab: the honest savings estimate and the routing policy
// string. No I/O — fed real turns, the real model registry, and real prefs/caps.

export interface SavingsTurn {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Rate {
  inUSDPerMtok: number;
  outUSDPerMtok: number;
}

// The "always-premium" baseline = the most expensive model in the registry. The
// router's most-expensive ELIGIBLE model is this one for any turn, because the
// priciest model clears every quality bar (eligibility only ever excludes models
// for *lacking* capability, never for being too good). So this is an honest upper
// baseline; we label the result an estimate ("~ … vs always-premium"). Pure.
export function premiumRate(registry: Array<{ cost?: Rate | null }>): Rate | null {
  let best: Rate | null = null;
  for (const m of registry) {
    if (!m.cost) continue;
    const blended = m.cost.inUSDPerMtok + m.cost.outUSDPerMtok;
    if (!best || blended > best.inUSDPerMtok + best.outUSDPerMtok) best = m.cost;
  }
  return best;
}

function premiumCost(turn: SavingsTurn, premium: Rate): number {
  return (turn.inputTokens / 1e6) * premium.inUSDPerMtok + (turn.outputTokens / 1e6) * premium.outUSDPerMtok;
}

// Savings vs always-premium: Σ(premium cost of each turn's tokens − the turn's
// ACTUAL cost). actualCostOf is injected (= estimateCost([turn]); a subscription
// seat ⇒ $0, so a seat turn's whole premium cost counts as saved — really did
// avoid paying premium API for it). Clamped ≥ 0. Returns null only when there is
// nothing real to compute from (no turns, or no priced model in the registry).
export function estimateSavings(
  turns: SavingsTurn[],
  premium: Rate | null,
  actualCostOf: (t: SavingsTurn) => number,
): number | null {
  if (!premium || !turns.length) return null;
  let baseline = 0;
  let actual = 0;
  for (const t of turns) {
    baseline += premiumCost(t, premium);
    actual += actualCostOf(t);
  }
  return Math.max(0, baseline - actual);
}

export interface PolicyInput {
  mode: "routing" | "fixed" | "subscription";
  pinnedModel?: string;
  subscriptionLabel?: string;
  prefer?: "subscription" | "api"; // global routing bias, if set
  caps?: { session?: number; daily?: number; monthly?: number; total?: number };
}

// The routing policy line — only ever states what the engine actually honours.
// There is NO per-turn cost cap in the engine, so this never prints one; it shows
// the real budget-guard caps (session/daily/monthly/total) only when they are set.
export function formatPolicyString(opts: PolicyInput): string {
  if (opts.mode === "fixed") {
    return `policy: pinned to ${opts.pinnedModel ?? "a model"} · /model auto to route`;
  }
  if (opts.mode === "subscription") {
    return `policy: ${opts.subscriptionLabel ?? "subscription seat"} · /account off to auto-route`;
  }
  let s = "policy: cheapest model passing the quality bar";
  if (opts.prefer === "subscription") s += " · prefer subscription seats";
  else if (opts.prefer === "api") s += " · prefer metered API";
  const caps = opts.caps ?? {};
  const order: Array<["session" | "daily" | "monthly" | "total", string]> = [
    ["session", "session"],
    ["daily", "daily"],
    ["monthly", "monthly"],
    ["total", "total"],
  ];
  const capParts = order
    .filter(([k]) => typeof caps[k] === "number" && caps[k]! > 0)
    .map(([k, label]) => `${label} cap $${caps[k]!.toFixed(2)}`);
  if (capParts.length) s += ` · ${capParts.join(" · ")}`;
  return s;
}

// The savings line text. Spend is always real; the savings clause is appended only
// when a real estimate exists, and is always tagged "~ … vs always-premium".
export function savingsLine(spendUSD: number, savingsUSD: number | null): string {
  const spend = `session $${spendUSD.toFixed(2)} spent`;
  if (savingsUSD == null || savingsUSD < 0.005) return spend;
  return `${spend} · ~$${savingsUSD.toFixed(2)} saved vs always-premium`;
}
