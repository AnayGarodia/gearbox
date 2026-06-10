// Pure helpers for the per-turn routing provenance line:
//
//     routed → <provider> · <model> · <cost>
//
// Printed once after every turn so you can always see what ACTUALLY ran and what
// it cost — the product's whole point is per-task routing, so the outcome is
// worth one dim line. It stays dim (a quiet grey) when the choice was routine,
// and brightens to amber + a short reason ONLY for one of three surprising cases
// (defined in the redesign brief):
//
//   (a) the router escalated above the cheapest eligible model,
//   (b) a provider fallback because the intended provider failed / was limited,
//   (c) the turn hit the per-turn cost cap.
//
// Every field here must be backed by a REAL signal from the routing/failover
// layer. Nothing is fabricated: a subscription seat reports "subscription seat"
// (its marginal cost really is ~$0), and a missing signal simply stays dim.
//
// No I/O, no rendering — the colours live in lines.ts / Transcript.tsx. This is
// the single source for the wording and the surprising/dim decision, so the two
// renderers (virtualized buffer + inline Static) cannot drift, and it is unit
// tested directly.

export type RouteKind = "metered" | "subscription";

export interface SurpriseSignals {
  // (a) router picked a model above the cheapest one that cleared the quality
  // bar. Derived by comparing the chosen model to the cheapest eligible in the
  // routing scorecard (wired where that scorecard is captured).
  escalated?: boolean;
  // (b) the model label the turn FELL BACK FROM, when same-turn failover moved
  // off the intended account (rate-limited / out of credit / expired). null/
  // undefined when the turn ran on its first choice.
  fellOverFrom?: string | null;
  // (c) a real per-turn cost cap blocked or forced the choice. Only ever true
  // when such a cap actually exists and fired.
  capHit?: boolean;
}

export interface RoutingLineInput extends SurpriseSignals {
  model: string; // model label that ACTUALLY ran this turn
  provider: string; // provider / backend it ran on
  costUSD: number; // real per-turn $ (a subscription seat is ~$0 marginal)
  kind: RouteKind;
  /** False when the model has no pricing data — "$0.00" would read as free. */
  priced?: boolean;
  /** WIRE TRUTH: the model id the provider's response says served the turn. */
  servedAs?: string;
  /** The sdk id we requested — compared against servedAs for the mismatch flag. */
  requestedSdkId?: string;
}

export interface RoutingLine {
  model: string;
  provider: string;
  costText: string; // "$0.04" | "<$0.01" | "$0.00" | "subscription seat"
  surprising: boolean;
  reason: string | null; // present ONLY when surprising
}

// Honest money formatting. A subscription seat is a flat-rate seat, so its
// per-turn marginal cost is ~$0 — we say "subscription seat" rather than print a
// misleading "$0.00" that could read as broken/free. Metered turns under a cent
// collapse to "<$0.01" instead of rounding to "$0.00".
export function formatTurnCost(costUSD: number, kind: RouteKind, priced = true): string {
  if (kind === "subscription") return "subscription seat";
  // No pricing data → say so. "$0.00" on an unpriced model reads as "free",
  // which is a guess wearing a number.
  if (!priced) return "$ unknown (no price data for this model)";
  if (!Number.isFinite(costUSD) || costUSD <= 0) return "$0.00";
  if (costUSD < 0.01) return "<$0.01";
  return `$${costUSD.toFixed(2)}`;
}

/** True when the wire-reported model id plausibly matches what we requested —
 *  providers decorate ids (dates, "deployment/" prefixes), so compare loosely:
 *  either contains the other after lowercasing/stripping separators. */
export function servedMatchesRequested(servedAs: string, requested: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(servedAs);
  const b = norm(requested);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

// Classify whether the decision was surprising, and why. Precedence is most-
// severe-first: a hard cap, then a provider fallback, then an escalation. Returns
// at most one reason (the line stays a single, scannable string).
export function classifySurprise(signals: SurpriseSignals): { surprising: boolean; reason: string | null } {
  if (signals.capHit) return { surprising: true, reason: "hit the per-turn cost cap" };
  if (signals.fellOverFrom) return { surprising: true, reason: `fell back from ${signals.fellOverFrom}` };
  if (signals.escalated) return { surprising: true, reason: "escalated above the cheapest model" };
  return { surprising: false, reason: null };
}

export function buildRoutingLine(input: RoutingLineInput): RoutingLine {
  let { surprising, reason } = classifySurprise(input);
  let model = input.model;
  // Wire-truth cross-check: when the provider reports which model served the
  // request, verify it against what we asked for. A match shows quietly
  // ("served as <wire id>"); a MISMATCH is the loudest thing on the line —
  // the user must never discover it by interrogating the model.
  if (input.servedAs) {
    if (!input.requestedSdkId) {
      // No model was explicitly requested (e.g. a subscription CLI running its
      // own default) — the wire id is information, not a verdict. Report it
      // quietly; comparing against a display label would invent false mismatches.
      model = servedMatchesRequested(input.servedAs, input.model)
        ? `${input.model} ✓wire`
        : `${input.model} · served as ${input.servedAs}`;
    } else if (servedMatchesRequested(input.servedAs, input.requestedSdkId)) {
      model = `${input.model} ✓wire`;
    } else {
      model = `${input.model} ⚠ provider served "${input.servedAs}"`;
      surprising = true;
      reason = reason ?? `the provider reports a different model than requested`;
    }
  }
  return {
    model,
    provider: input.provider,
    costText: formatTurnCost(input.costUSD, input.kind, input.priced ?? true),
    surprising,
    reason,
  };
}

// Plain one-line string — the fallback renderer and the unit-test anchor. The
// styled renderers split this into spans, but the wording is defined once here.
export function routingLineText(line: RoutingLine): string {
  const base = `routed → ${line.provider} · ${line.model} · ${line.costText}`;
  return line.surprising && line.reason ? `${base} · ${line.reason}` : base;
}
