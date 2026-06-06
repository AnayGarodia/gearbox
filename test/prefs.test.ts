import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gbprefs-"));
process.env.GEARBOX_HOME = dir;
afterEach(() => {});

test("prefs round-trip through ~/.gearbox/prefs.json", async () => {
  const { loadPrefs, savePrefs, updatePrefs } = await import("../src/ui/prefs.ts");
  expect(loadPrefs()).toEqual({});
  savePrefs({ vim: true });
  expect(loadPrefs().vim).toBe(true);
  const p = updatePrefs({ notify: false });
  expect(p).toEqual({ vim: true, notify: false });
  expect(loadPrefs().notify).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("color palette has all required keys", async () => {
  const { color } = await import("../src/ui/theme.ts");
  expect(typeof color.accent).toBe("string");
  expect(typeof color.navy).toBe("string");
  expect(typeof color.codeKeyword).toBe("string");
  expect(typeof color.ok).toBe("string");
  expect(typeof color.err).toBe("string");
});
