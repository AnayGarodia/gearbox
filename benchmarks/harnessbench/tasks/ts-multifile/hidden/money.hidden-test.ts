import { expect, test } from "bun:test";
import { fromDollars, addMoney } from "../src/money.ts";
import { cartTotal } from "../src/cart.ts";
test("integer cents, half-up", () => {
  expect(fromDollars(1.10).cents).toBe(110);
  expect(fromDollars(0.005).cents).toBe(1);
});
test("exact totals", () => {
  expect(cartTotal([{ price: fromDollars(1.10), qty: 2 }])).toEqual(fromDollars(2.20));
  expect(addMoney(fromDollars(0.1), fromDollars(0.2))).toEqual(fromDollars(0.3));
});
