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
  savePrefs({ theme: "light" });
  expect(loadPrefs().theme).toBe("light");
  const p = updatePrefs({ notify: false });
  expect(p).toEqual({ theme: "light", notify: false });
  expect(loadPrefs().notify).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("setTheme swaps the active color palette in place", async () => {
  const { color, setTheme, THEMES } = await import("../src/ui/theme.ts");
  expect(setTheme("light")).toBe(true);
  expect(color.text).toBe(THEMES.light!.text);
  expect(setTheme("nope")).toBe(false);
  setTheme("dark"); // restore
  expect(color.text).toBe(THEMES.dark!.text);
});
