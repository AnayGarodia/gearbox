import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the usage ledger to a temp GEARBOX_HOME so we don't touch real data.
process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gbx-usage-"));
const { recordUsage, accountUsage, spentToday } = await import("../src/accounts/usage.ts");

describe("daily spend bucket", () => {
  test("spentToday accumulates the day's cost for an account", () => {
    recordUsage({ accountId: "acct-day", inputTokens: 10, outputTokens: 5, costUSD: 0.4, estimated: true });
    recordUsage({ accountId: "acct-day", inputTokens: 10, outputTokens: 5, costUSD: 0.6, estimated: true });
    const u = accountUsage("acct-day")!;
    expect(spentToday(u, Date.now())).toBeCloseTo(1.0, 5);
  });

  test("spentToday is 0 once the day key no longer matches", () => {
    recordUsage({ accountId: "acct-day2", inputTokens: 1, outputTokens: 1, costUSD: 0.5, estimated: true });
    const u = accountUsage("acct-day2")!;
    const tomorrow = Date.now() + 36 * 60 * 60 * 1000;
    expect(spentToday(u, tomorrow)).toBe(0);
  });
});
