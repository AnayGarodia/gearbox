import { test, expect, beforeEach, afterEach } from "bun:test";
import { setPermissionHandler, requestPermission, resetPermissions } from "../src/permission.ts";

beforeEach(() => {
  setPermissionHandler(null);
  resetPermissions();
});
afterEach(() => {
  setPermissionHandler(null);
  resetPermissions();
});

test("no handler installed → allowed (headless/test use is unchanged)", async () => {
  expect(await requestPermission({ kind: "shell", title: "", detail: "ls" })).toBe(true);
});

test("deny → false; once → true, and it asks again next time", async () => {
  let calls = 0;
  setPermissionHandler(async () => (++calls === 1 ? "deny" : "once"));
  expect(await requestPermission({ kind: "write", title: "", detail: "a.ts" })).toBe(false);
  expect(await requestPermission({ kind: "write", title: "", detail: "a.ts" })).toBe(true);
  expect(calls).toBe(2);
});

test("always → granted for that kind, not asked again", async () => {
  let calls = 0;
  setPermissionHandler(async () => (calls++, "always"));
  expect(await requestPermission({ kind: "shell", title: "", detail: "x" })).toBe(true);
  expect(await requestPermission({ kind: "shell", title: "", detail: "y" })).toBe(true);
  expect(calls).toBe(1);
  // a different kind is still gated
  expect(await requestPermission({ kind: "write", title: "", detail: "z" })).toBe(true);
  expect(calls).toBe(2);
});
