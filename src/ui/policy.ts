// Pure helper for the routing POLICY label shown inside the input box.
//
// The input box shows the policy (intent), never a bare model name in the common
// auto case — that keeps a model name from appearing in two places with two
// meanings (the bug the redesign fixes). `selectorKind` is derived from the live
// selector in App.tsx (instanceof RoutingSelector/FixedSelector + activeCli) and
// passed in as a plain string, so this module stays dependency-free and testable.
export type SelectorKind = "routing" | "fixed" | "subscription";

export function policyLabel(args: {
  selectorKind: SelectorKind;
  pinnedModelLabel?: string; // the model label when a model is pinned (/model X)
  subscriptionLabel?: string; // the account label on a subscription (e.g. "claude · Max")
  mode: "normal" | "auto-accept" | "plan";
}): string {
  const { selectorKind, pinnedModelLabel, subscriptionLabel, mode } = args;
  const base =
    selectorKind === "subscription"
      ? subscriptionLabel ?? "subscription"
      : selectorKind === "fixed"
      ? pinnedModelLabel
        ? `pinned ${pinnedModelLabel}`
        : "pinned"
      : "auto-route";
  // Mode prefix leads the label because it changes what the turn does (plan =
  // read-only, auto-accept = applies writes without confirmation).
  const prefix = mode === "plan" ? "plan · " : mode === "auto-accept" ? "auto-accept · " : "";
  return `${prefix}${base}`;
}
