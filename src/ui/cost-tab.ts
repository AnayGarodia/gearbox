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

// The "always-premium" baseline uses the most expensive model in the registry.
// The priciest model clears every quality bar, so it is always eligible, making
// this an honest upper baseline. Results are labeled "~ … vs always-premium". Pure.
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

// Savings vs always-premium: sum of (premium token cost − actual cost) per turn.
// actualCostOf is injected; a subscription seat returns $0, so the full premium
// cost counts as saved. Clamped to 0. Returns null when there is nothing to
// compute (no turns, or no priced model in the registry).
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

// The routing policy line: states only what the engine honours. Budget-guard caps
// (session/daily/monthly/total) are shown only when set.
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

// Savings line text. Spend is always real; the savings clause is appended only
// when a real estimate exists, always tagged "~ … vs always-premium".
export function savingsLine(spendUSD: number, savingsUSD: number | null): string {
  const spend = `session $${spendUSD.toFixed(2)} spent`;
  if (savingsUSD == null || savingsUSD < 0.005) return spend;
  return `${spend} · ~$${savingsUSD.toFixed(2)} saved vs always-premium`;
}
