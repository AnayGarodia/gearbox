import { expect, test } from "bun:test";
import { transition } from "../src/order.ts";
test("legal moves", () => {
  expect(transition("pending", "paid")).toBe("paid");
  expect(transition("pending", "cancelled")).toBe("cancelled");
  expect(transition("paid", "shipped")).toBe("shipped");
  expect(transition("paid", "refunded")).toBe("refunded");
  expect(transition("shipped", "delivered")).toBe("delivered");
});
test("illegal moves throw and name the states", () => {
  const cases: [string, string][] = [
    ["shipped", "paid"], ["cancelled", "pending"], ["cancelled", "paid"],
    ["delivered", "pending"], ["refunded", "paid"], ["pending", "shipped"], ["pending", "delivered"],
  ];
  for (const [f, t] of cases) {
    expect(() => transition(f as any, t as any)).toThrow();
    try { transition(f as any, t as any); } catch (e: any) {
      expect(String(e.message)).toContain(f);
      expect(String(e.message)).toContain(t);
    }
  }
});
