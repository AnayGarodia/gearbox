import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.GEARBOX_HOME;
  dir = mkdtempSync(join(tmpdir(), "gearbox-usage-"));
  process.env.GEARBOX_HOME = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("a status-only window (no utilization) renders as a status, not a fake %", async () => {
  const { recordUsage, recordRateLimits, buildUsageView } = await import("../src/accounts/usage.ts");
  recordUsage({ accountId: "sub1", inputTokens: 100, outputTokens: 10, costUSD: 0, estimated: false });
  recordRateLimits("sub1", [{ status: "allowed", type: "five_hour", resetsAt: 1780830600 }]);
  const view = buildUsageView(0, () => ({ name: "Claude", kind: "sub" }), Date.now(), ["sub1"]);
  const sub = view.subscriptions[0]!;
  expect(sub.limits?.length).toBe(1);
  expect(sub.limits![0]!.pct).toBeUndefined();
  expect(sub.limits![0]!.status).toBe("ok");
  expect(sub.limitNote).toBeUndefined(); // not the "hasn't reported" note anymore
});

test("a numeric utilization window still renders a percentage", async () => {
  const { recordUsage, recordRateLimits, buildUsageView } = await import("../src/accounts/usage.ts");
  recordUsage({ accountId: "sub2", inputTokens: 100, outputTokens: 10, costUSD: 0, estimated: false });
  recordRateLimits("sub2", [{ utilization: 0.4, type: "seven_day" }]);
  const view = buildUsageView(0, () => ({ name: "Claude", kind: "sub" }), Date.now(), ["sub2"]);
  expect(view.subscriptions[0]!.limits![0]!.pct).toBe(40);
});
