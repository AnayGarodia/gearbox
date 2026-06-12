import { expect, test } from "bun:test";
import { fetchWithFallback } from "../src/fetch";
const ok = (v: string) => () => Promise.resolve(v);
const fail = (msg: string) => () => Promise.reject(new Error(msg));
test("primary success", async () => { expect(await fetchWithFallback(ok("A"), ok("B"))).toBe("A"); });
test("fallback on primary failure", async () => { expect(await fetchWithFallback(fail("x"), ok("B"))).toBe("B"); });
test("rejects when both fail", async () => {
  await expect(fetchWithFallback(fail("primary"), fail("fallback"))).rejects.toThrow("fallback");
});
test("does not resolve null on total failure", async () => {
  const result = fetchWithFallback(fail("a"), fail("b")).then(() => "resolved", () => "rejected");
  expect(await result).toBe("rejected");
});
