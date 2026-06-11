// Conductor pure helpers + the per-root permission/checkpoint routing seams the
// tab model rides on. The full multi-App mount is exercised by hand (it needs a
// real TTY + alt screen); these pin the logic that decides routing and the chip.
import { test, expect } from "bun:test";
import { tabRowsOf, tabSlug } from "../src/ui/components/Conductor.tsx";
import { requestPermission, registerPermissionHandler, setPermissionHandler, registerPreMutationHook, resetPermissions } from "../src/permission.ts";

const status = (busy: boolean, needsInput = false, title = "t") => ({ busy, needsInput, title });

test("tabRowsOf: maps status + active flag; falls back to the dir basename", () => {
  const rows = tabRowsOf(
    [
      { dir: "/x/main", status: status(false, false, "") },
      { dir: "/x/fix", status: status(true, false, "fix auth") },
      { dir: "/x/docs", status: status(false, true, "docs") },
    ],
    1,
  );
  expect(rows.map((r) => r.title)).toEqual(["main", "fix auth", "docs"]);
  expect(rows.map((r) => r.active)).toEqual([false, true, false]);
  expect(rows[1]!.busy).toBe(true);
  expect(rows[2]!.needsInput).toBe(true);
});

test("tabRowsOf: unseen marks done on hidden tabs only (the active tab has no badge to ack)", () => {
  const rows = tabRowsOf(
    [
      { dir: "/x/a", status: status(false), unseen: true },
      { dir: "/x/b", status: status(false), unseen: true },
    ],
    0,
  );
  expect(rows[0]!.done).toBe(false); // active: visible on screen, nothing to flag
  expect(rows[1]!.done).toBe(true);
});

test("tabSlug: sanitizes names, falls back to tab-<id>", () => {
  expect(tabSlug("Fix Auth!", 4)).toBe("fix-auth");
  expect(tabSlug("  ", 4)).toBe("tab-4");
  expect(tabSlug(undefined, 7)).toBe("tab-7");
});

test("permission requests route to the handler registered for their root", async () => {
  resetPermissions();
  const calls: string[] = [];
  registerPermissionHandler("/tab/a", async () => { calls.push("a"); return "once"; });
  registerPermissionHandler("/tab/b", async () => { calls.push("b"); return "deny"; });
  setPermissionHandler(async () => { calls.push("global"); return "once"; });
  try {
    expect(await requestPermission({ kind: "write", title: "w", detail: "x", root: "/tab/a" })).toBe(true);
    expect(await requestPermission({ kind: "write", title: "w", detail: "x", root: "/tab/b" })).toBe(false);
    // No root / unknown root → the global (active-tab) handler.
    expect(await requestPermission({ kind: "write", title: "w", detail: "x" })).toBe(true);
    expect(await requestPermission({ kind: "write", title: "w", detail: "x", root: "/elsewhere" })).toBe(true);
    expect(calls).toEqual(["a", "b", "global", "global"]);
  } finally {
    registerPermissionHandler("/tab/a", null);
    registerPermissionHandler("/tab/b", null);
    setPermissionHandler(null);
    resetPermissions();
  }
});

test("pre-mutation hooks route by root too (each tab checkpoints its own tree)", async () => {
  resetPermissions();
  const hits: string[] = [];
  registerPreMutationHook("/tab/a", () => hits.push("a"));
  try {
    await requestPermission({ kind: "shell", title: "s", detail: "ls", root: "/tab/a" });
    await requestPermission({ kind: "shell", title: "s", detail: "ls", root: "/tab/other" });
    expect(hits).toEqual(["a"]); // no global hook installed → other roots skip
  } finally {
    registerPreMutationHook("/tab/a", null);
    resetPermissions();
  }
});

test("tabRowsOf: a tab's own name beats the dir basename (same-dir tabs aren't all 'Desktop')", () => {
  const rows = tabRowsOf(
    [
      { dir: "/Users/me/Desktop", name: "gearbox", status: status(false, false, "") },
      { dir: "/Users/me/Desktop", name: "wizard", status: status(false, false, "") },
      { dir: "/Users/me/Desktop", name: "skater", status: status(false, false, "say PLUM") },
    ],
    0,
  );
  expect(rows.map((r) => r.title)).toEqual(["gearbox", "wizard", "say PLUM"]); // session title still wins
});
