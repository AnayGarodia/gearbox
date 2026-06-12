import { expect, test } from "bun:test";
import { memoAsync } from "../src/once.ts";

test("concurrent same-key calls share one invocation", async () => {
  let calls = 0;
  const m = memoAsync(async (k) => { calls++; await new Promise((r) => setTimeout(r, 20)); return k.toUpperCase(); });
  const [a, b] = await Promise.all([m("x"), m("x")]);
  expect(a).toBe("X");
  expect(b).toBe("X");
  expect(calls).toBe(1);
});

test("success caches; rejection clears for retry", async () => {
  let calls = 0;
  const m = memoAsync(async (k) => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return "ok";
  });
  await expect(m("k")).rejects.toThrow("transient");
  await expect(m("k")).resolves.toBe("ok"); // retried, not poisoned
  await expect(m("k")).resolves.toBe("ok"); // now cached
  expect(calls).toBe(2);
});

test("distinct keys are independent", async () => {
  const m = memoAsync(async (k) => k + "!");
  expect(await m("a")).toBe("a!");
  expect(await m("b")).toBe("b!");
});
