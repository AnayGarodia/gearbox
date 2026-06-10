import { test, expect } from "bun:test";
import { policyLabel } from "../src/ui/policy.ts";

test("auto-route is the default policy in normal mode", () => {
  expect(policyLabel({ selectorKind: "routing", mode: "normal" })).toBe("auto-route");
});

test("plan / auto-accept modes lead the policy line", () => {
  expect(policyLabel({ selectorKind: "routing", mode: "plan" })).toBe("plan · auto-route");
  expect(policyLabel({ selectorKind: "routing", mode: "auto-accept" })).toBe("auto-accept · auto-route");
});

test("a pinned model says just 'pinned' — the model itself is named once, on the footer's right", () => {
  expect(policyLabel({ selectorKind: "fixed", pinnedModelLabel: "sonnet-4.6", mode: "normal" })).toBe(
    "pinned",
  );
  expect(policyLabel({ selectorKind: "fixed", pinnedModelLabel: "sonnet-4.6", mode: "plan" })).toBe(
    "plan · pinned",
  );
});

test("a pin with no resolvable label degrades to bare 'pinned' (never invents a name)", () => {
  expect(policyLabel({ selectorKind: "fixed", mode: "normal" })).toBe("pinned");
});

test("a subscription says just 'subscription' — the seat is named once, on the meter", () => {
  expect(policyLabel({ selectorKind: "subscription", subscriptionLabel: "claude · Max", mode: "normal" })).toBe(
    "subscription",
  );
  expect(policyLabel({ selectorKind: "subscription", subscriptionLabel: "claude · Max", mode: "plan" })).toBe(
    "plan · subscription",
  );
});

test("a subscription with no label degrades to 'subscription'", () => {
  expect(policyLabel({ selectorKind: "subscription", mode: "normal" })).toBe("subscription");
});
