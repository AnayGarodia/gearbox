import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { CostView, RoutingView } from "../src/ui/components/TabViews.tsx";

test("CostView renders the savings line, policy, and per-account spend", () => {
  const out =
    render(
      <CostView
        width={80}
        savingsText="session $0.04 spent · ~$0.31 saved vs always-premium"
        policyText="policy: cheapest model passing the quality bar"
        spendRows={[{ label: "anthropic", spent: "$0.04 spent" }]}
      />,
    ).lastFrame() ?? "";
  expect(out).toContain("~$0.31 saved vs always-premium");
  expect(out).toContain("cheapest model passing the quality bar");
  expect(out).toContain("anthropic");
  expect(out).not.toContain("/turn"); // never claims a per-turn cap
});

test("RoutingView renders policy, last pick, and remembered preferences", () => {
  const out =
    render(
      <RoutingView
        width={80}
        policyText="policy: cheapest model passing the quality bar"
        lastPick="anthropic · haiku-4.5 · cheapest clearing the bar"
        kindPrefs={[{ kind: "summarize", model: "haiku-4.5" }]}
      />,
    ).lastFrame() ?? "";
  expect(out).toContain("last turn");
  expect(out).toContain("haiku-4.5");
  expect(out).toContain("summarize → haiku-4.5");
  expect(out).toContain("/why");
});

test("RoutingView omits the last-pick line when there is none", () => {
  const out = render(<RoutingView width={80} policyText="policy: x" lastPick={null} kindPrefs={[]} />).lastFrame() ?? "";
  expect(out).not.toContain("last turn");
});
