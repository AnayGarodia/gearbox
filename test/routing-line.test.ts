import { test, expect } from "bun:test";
import {
  formatTurnCost,
  classifySurprise,
  buildRoutingLine,
  routingLineText,
} from "../src/ui/routing-line.ts";

test("formatTurnCost: subscription seat is never a misleading dollar amount", () => {
  expect(formatTurnCost(0, "subscription")).toBe("subscription seat");
  expect(formatTurnCost(5, "subscription")).toBe("subscription seat"); // metered-equiv is fiction for a seat
});

test("formatTurnCost: metered turns format honestly, sub-cent collapses to <$0.01", () => {
  expect(formatTurnCost(0, "metered")).toBe("$0.00");
  expect(formatTurnCost(0.0004, "metered")).toBe("<$0.01");
  expect(formatTurnCost(0.009, "metered")).toBe("<$0.01");
  expect(formatTurnCost(0.04, "metered")).toBe("$0.04");
  expect(formatTurnCost(1.2, "metered")).toBe("$1.20");
});

test("formatTurnCost: guards against NaN/negative (never prints garbage)", () => {
  expect(formatTurnCost(NaN, "metered")).toBe("$0.00");
  expect(formatTurnCost(-1, "metered")).toBe("$0.00");
});

test("classifySurprise: routine decision is not surprising and carries no reason", () => {
  expect(classifySurprise({})).toEqual({ surprising: false, reason: null });
  expect(classifySurprise({ escalated: false, fellOverFrom: null, capHit: false })).toEqual({
    surprising: false,
    reason: null,
  });
});

test("classifySurprise: each of the three brief cases brightens with its own reason", () => {
  expect(classifySurprise({ escalated: true })).toEqual({
    surprising: true,
    reason: "escalated above the cheapest model",
  });
  expect(classifySurprise({ fellOverFrom: "gpt-5" })).toEqual({
    surprising: true,
    reason: "fell back from gpt-5",
  });
  expect(classifySurprise({ capHit: true })).toEqual({
    surprising: true,
    reason: "hit the per-turn cost cap",
  });
});

test("classifySurprise: precedence is cap > fallback > escalation (one reason only)", () => {
  expect(classifySurprise({ capHit: true, fellOverFrom: "x", escalated: true }).reason).toBe(
    "hit the per-turn cost cap",
  );
  expect(classifySurprise({ fellOverFrom: "x", escalated: true }).reason).toBe("fell back from x");
});

test("buildRoutingLine: composes the real fields + surprise verdict", () => {
  const routine = buildRoutingLine({
    model: "haiku",
    provider: "anthropic",
    costUSD: 0.004,
    kind: "metered",
  });
  expect(routine).toEqual({
    model: "haiku",
    provider: "anthropic",
    costText: "<$0.01",
    surprising: false,
    reason: null,
  });

  const sub = buildRoutingLine({ model: "sonnet", provider: "claude", costUSD: 0, kind: "subscription" });
  expect(sub.costText).toBe("subscription seat");
  expect(sub.surprising).toBe(false);
});

test("routingLineText: routine prints a dim single line; surprising appends the reason", () => {
  const routine = buildRoutingLine({ model: "haiku", provider: "anthropic", costUSD: 0.04, kind: "metered" });
  expect(routingLineText(routine)).toBe("routed → anthropic · haiku · $0.04");

  const surprising = buildRoutingLine({
    model: "opus",
    provider: "anthropic",
    costUSD: 0.5,
    kind: "metered",
    fellOverFrom: "gpt-5",
  });
  expect(routingLineText(surprising)).toBe("routed → anthropic · opus · $0.50 · fell back from gpt-5");
});

import { servedMatchesRequested } from "../src/ui/routing-line.ts";

test("wire-truth: the routing line verifies the provider's reported model", () => {
  // Match (decorated ids count): quiet ✓wire tag.
  const ok = buildRoutingLine({ model: "DeepSeek-V4-Pro", provider: "azure-foundry", costUSD: 0.01, kind: "metered", servedAs: "deepseek-v4-pro", requestedSdkId: "DeepSeek-V4-Pro" });
  expect(ok.model).toContain("✓wire");
  expect(ok.surprising).toBe(false);
  // MISMATCH: the loudest thing on the line.
  const bad = buildRoutingLine({ model: "DeepSeek-V4-Pro", provider: "azure-foundry", costUSD: 0.01, kind: "metered", servedAs: "claude-sonnet-4-6", requestedSdkId: "DeepSeek-V4-Pro" });
  expect(bad.model).toContain('provider served "claude-sonnet-4-6"');
  expect(bad.surprising).toBe(true);
});

test("servedMatchesRequested tolerates provider id decoration", () => {
  expect(servedMatchesRequested("claude-sonnet-4-6-20251114", "claude-sonnet-4-6")).toBe(true);
  expect(servedMatchesRequested("gpt-5.5-2026-01-12", "gpt-5.5")).toBe(true);
  expect(servedMatchesRequested("claude-sonnet-4-6", "DeepSeek-V4-Pro")).toBe(false);
});

test("unpriced models say so instead of $0.00", () => {
  expect(formatTurnCost(0, "metered", false)).toContain("unknown");
  expect(formatTurnCost(0, "metered", true)).toBe("$0.00");
  const line = buildRoutingLine({ model: "x", provider: "p", costUSD: 0, kind: "metered", priced: false });
  expect(line.costText).toContain("no price data");
});
