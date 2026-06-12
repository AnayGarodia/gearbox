import { expect, test } from "bun:test";
import { formatPrice } from "./price";

// Existing contract: dollar-sign prefix.
test("formats with dollar sign", () => {
  expect(formatPrice(1)).toBe("$1.00");
  expect(formatPrice(9.99)).toBe("$9.99");
  expect(formatPrice(0)).toBe("$0.00");
});
