import { expect, test } from "bun:test";
import { stamp } from "../src/stamp.ts";
test("format unchanged: local time with explicit offset, not Z", () => {
  const s = stamp(new Date(2026, 5, 12, 14, 3, 0));
  expect(s).toMatch(/^2026-06-12T14:03:00[+-]\d{2}:\d{2}$/);
});
