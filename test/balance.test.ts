import { test, expect } from "bun:test";
import { parseBalance, balanceExposed } from "../src/accounts/balance.ts";

// Each provider's balance shape is different; parse must coerce strings to
// numbers and never throw on a missing/odd field (it returns null instead).

test("openrouter: remaining = total_credits − total_usage", () => {
  expect(parseBalance("openrouter", { data: { total_credits: 20, total_usage: 7.5 } }))
    .toEqual({ remainingUSD: 12.5, totalUSD: 20 });
});

test("vercel-gateway: balance arrives as a USD string", () => {
  expect(parseBalance("vercel-gateway", { balance: "95.50", total_used: "4.50" }))
    .toEqual({ remainingUSD: 95.5 });
});

test("deepseek: picks the USD entry and parses the string total_balance", () => {
  const body = { is_available: true, balance_infos: [
    { currency: "CNY", total_balance: "800.00" },
    { currency: "USD", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
  ] };
  expect(parseBalance("deepseek", body)).toEqual({ remainingUSD: 110 });
  expect(balanceExposed("deepseek")).toBe(true);
});

test("deepseek: a CNY-only balance converts (coarsely) instead of masquerading as USD", () => {
  // ¥42 reported as $42 overstated the balance ~7x and let a nearly-broke key
  // keep winning cheapest-model routing. An estimate beats going blind.
  const b = parseBalance("deepseek", { balance_infos: [{ currency: "CNY", total_balance: "42" }] });
  expect(b?.remainingUSD).toBeCloseTo(42 / 7.2, 2);
});

test("returns null on unknown provider or unparseable body", () => {
  expect(parseBalance("anthropic", { whatever: 1 })).toBeNull(); // no reader → no scarcity signal
  expect(parseBalance("deepseek", { balance_infos: [] })).toBeNull();
  expect(parseBalance("openrouter", { data: {} })).toBeNull();
});
