import { test, expect, describe } from "bun:test";
import { checkCaps, type BudgetCaps, type SpendSnapshot } from "../src/model/budget-guard.ts";

const spend = (p: Partial<SpendSnapshot> = {}): SpendSnapshot => ({ session: 0, daily: 0, total: 0, monthly: 0, ...p });

describe("checkCaps", () => {
  test("allows when no caps are configured", () => {
    expect(checkCaps({}, spend({ session: 999 })).allowed).toBe(true);
  });

  test("allows when spend is under every cap", () => {
    const caps: BudgetCaps = { session: 5, daily: 20 };
    expect(checkCaps(caps, spend({ session: 2, daily: 10 })).allowed).toBe(true);
  });

  test("blocks when session spend has reached the session cap", () => {
    const v = checkCaps({ session: 5 }, spend({ session: 5 }));
    expect(v.allowed).toBe(false);
    expect(v.hit).toBe("session");
  });

  test("blocks when a pending turn estimate would cross the cap", () => {
    const v = checkCaps({ session: 5 }, spend({ session: 4.8 }), 0.5);
    expect(v.allowed).toBe(false);
    expect(v.hit).toBe("session");
  });

  test("does not block when the pending estimate still fits", () => {
    expect(checkCaps({ session: 5 }, spend({ session: 4.0 }), 0.5).allowed).toBe(true);
  });

  test("reports a daily breach independent of session", () => {
    const v = checkCaps({ daily: 20 }, spend({ session: 1, daily: 20 }));
    expect(v.allowed).toBe(false);
    expect(v.hit).toBe("daily");
  });

  test("honors total and monthly caps too", () => {
    expect(checkCaps({ total: 100 }, spend({ total: 100 })).allowed).toBe(false);
    expect(checkCaps({ monthly: 50 }, spend({ monthly: 60 })).allowed).toBe(false);
  });

  test("a breach carries an actionable message naming the cap and amounts", () => {
    const v = checkCaps({ session: 5 }, spend({ session: 6 }));
    expect(v.message).toContain("session");
    expect(v.message).toContain("5");
    expect(v.message?.toLowerCase()).toContain("/cap");
  });
});
